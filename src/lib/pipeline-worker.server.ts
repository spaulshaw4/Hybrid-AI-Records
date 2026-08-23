/**
 * Process-local heavy-audio pipeline worker:
 * - one active heavy job per slot (default concurrency 1)
 * - outer watchdog that frees the slot on stall
 * - heartbeat via generation_tasks.updated_at (no new columns)
 * - SIGTERM/SIGINT drain: mark in-flight jobs failed + purge /tmp orphans
 * - capped auto-retry for transient network only (never infinite on fatal model errors)
 */

import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withTimeout } from "@/lib/pipeline-gate.server";
import { GATE_TIMEOUTS_MS } from "@/lib/pipeline-gate.server";
import { explainEngineFailure } from "@/lib/engine-failure";
import { runSafeHook } from "@/lib/pipeline-hooks.server";

/** Default: one heavy 6-gate pipeline at a time per Node process. */
export const HEAVY_PIPELINE_SLOTS = Math.max(
  1,
  Number.parseInt(process.env.HEAVY_PIPELINE_SLOTS ?? "1", 10) || 1,
);

/** How long a request may wait for a free heavy slot before 503. */
export const HEAVY_SLOT_WAIT_MS = 60_000;

/** Sum of per-gate budgets + slack for vault/persist bookkeeping. */
export const PIPELINE_WATCHDOG_MS =
  Object.values(GATE_TIMEOUTS_MS).reduce((a, b) => a + b, 0) + 60_000;

/** Heartbeat interval — stale `updated_at` implies a dead runner. */
export const WORKER_HEARTBEAT_MS = 15_000;

/**
 * Stale processing rows (no heartbeat) older than this are marked failed
 * when a sweeper runs (boot / SIGTERM).
 */
export const STALE_HEARTBEAT_MS = WORKER_HEARTBEAT_MS * 4;

/** Cap on transient network auto-retries per job. */
export const MAX_TRANSIENT_RETRIES = 2;

const ORPHAN_TMP_PREFIXES = ["hybrid-matchering-", "vocal-ref-", "hybrid-pipeline-"] as const;

export class WorkerSlotBusyError extends Error {
  readonly statusCode = 503 as const;
  constructor(message = "All heavy audio pipeline slots are busy. Try again shortly.") {
    super(message);
    this.name = "WorkerSlotBusyError";
  }
}

export class WorkerWatchdogError extends Error {
  constructor(ms: number) {
    super(`[Worker Watchdog] Heavy pipeline job exceeded ${ms / 1000}s and was aborted.`);
    this.name = "WorkerWatchdogError";
  }
}

type InFlightJob = {
  trackId: string;
  userId: string;
  startedAt: number;
  attempt: number;
  abort: AbortController;
  tempPaths: Set<string>;
};

const inFlight = new Map<string, InFlightJob>();
const orphanTempPaths = new Set<string>();

let activeSlots = 0;
const slotWaiters: Array<{
  resolve: (release: () => void) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}> = [];

let shutdownHandlersInstalled = false;
let shuttingDown = false;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function releaseSlot(): void {
  activeSlots = Math.max(0, activeSlots - 1);
  const next = slotWaiters.shift();
  if (!next) return;
  clearTimeout(next.timer);
  activeSlots += 1;
  next.resolve(() => releaseSlot());
}

async function acquireHeavySlot(): Promise<() => void> {
  if (shuttingDown) {
    throw new WorkerSlotBusyError("Server is shutting down; refusing new pipeline jobs.");
  }
  if (activeSlots < HEAVY_PIPELINE_SLOTS) {
    activeSlots += 1;
    return () => releaseSlot();
  }
  return new Promise<() => void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = slotWaiters.findIndex((w) => w.resolve === resolve);
      if (idx >= 0) slotWaiters.splice(idx, 1);
      reject(new WorkerSlotBusyError());
    }, HEAVY_SLOT_WAIT_MS);
    slotWaiters.push({ resolve, reject, timer });
  });
}

/** Register a temp path for crash / SIGTERM orphan cleanup. */
export function registerWorkerTempPath(path: string): void {
  if (!path.trim()) return;
  orphanTempPaths.add(path);
  const job = [...inFlight.values()].find(Boolean);
  // Prefer attaching to the most recent in-flight job when trackId unknown.
  if (job) job.tempPaths.add(path);
}

export function registerWorkerTempPathForTrack(trackId: string, path: string): void {
  if (!path.trim()) return;
  orphanTempPaths.add(path);
  inFlight.get(trackId)?.tempPaths.add(path);
}

export function unregisterWorkerTempPath(path: string): void {
  orphanTempPaths.delete(path);
  for (const job of inFlight.values()) job.tempPaths.delete(path);
}

async function purgePath(path: string): Promise<void> {
  try {
    await fs.promises.rm(path, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  unregisterWorkerTempPath(path);
}

/** Wipe registered temps + known OS-tmp prefixes from stalled runners. */
export async function cleanupOrphanTempFiles(options?: {
  maxAgeMs?: number;
}): Promise<number> {
  const maxAgeMs = options?.maxAgeMs ?? STALE_HEARTBEAT_MS;
  let cleaned = 0;

  for (const path of [...orphanTempPaths]) {
    await purgePath(path);
    cleaned += 1;
  }

  const root = tmpdir();
  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(root);
  } catch {
    return cleaned;
  }

  const now = Date.now();
  await Promise.all(
    entries
      .filter((name) => ORPHAN_TMP_PREFIXES.some((p) => name.startsWith(p)))
      .map(async (name) => {
        const full = join(root, name);
        try {
          const stat = await fs.promises.stat(full);
          if (now - stat.mtimeMs < maxAgeMs) return;
          await fs.promises.rm(full, { recursive: true, force: true });
          cleaned += 1;
        } catch {
          /* ignore */
        }
      }),
  );
  return cleaned;
}

async function touchHeartbeat(trackId: string, userId: string): Promise<void> {
  await runSafeHook(`worker heartbeat ${trackId}`, async () => {
    const { createEngineSupabaseClient } = await import("@/lib/engine-pipeline.server");
    const supabase = createEngineSupabaseClient();
    if (!supabase) return;
    const now = new Date().toISOString();
    const { error } = await supabase
      .from("generation_tasks")
      .upsert(
        {
          id: trackId,
          user_id: userId,
          status: "processing",
          updated_at: now,
        } as never,
        { onConflict: "id" },
      );
    if (error) throw new Error(error.message);
  });
}

async function markJobFailed(trackId: string, userId: string, reason: string): Promise<void> {
  await runSafeHook(`worker mark failed ${trackId}`, async () => {
    const { failGenerationTask } = await import("@/lib/engine-pipeline.server");
    await failGenerationTask({ taskId: trackId, userId, reason });
  });
}

/**
 * Transient network / gateway drops — safe to auto-retry a few times.
 * Fatal model / auth / payload errors must not loop.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  if (
    /econnreset|etimedout|econnrefused|socket hang up|fetch failed|network|offline|und_err|enotfound/.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b502\b|\b503\b|\b504\b/.test(text)) return true;
  const explained = explainEngineFailure(error);
  return explained.kind === "network";
}

/** Fatal model / credential / brief errors — do not auto-retry. */
export function isFatalPipelineError(error: unknown): boolean {
  if (error instanceof WorkerSlotBusyError) return true;
  const text = errorMessage(error).toLowerCase();
  if (
    /invalid api key|incorrect api key|unauthorized|forbidden|\b401\b|\b403\b/.test(text)
  ) {
    return true;
  }
  if (
    /lyrics are required|out of range|too small|too big|rejected this brief|invalid audio|empty audio buffer/.test(
      text,
    )
  ) {
    return true;
  }
  if (/\b400\b|\b422\b/.test(text) && /music|model|payload|replicate|aimusic|suno/.test(text)) {
    return true;
  }
  const explained = explainEngineFailure(error);
  if (explained.kind === "auth" || explained.kind === "payload") return true;
  // Soft gate fallbacks already absorbed model soft-fails; hard Gate 4/6 model
  // rejection after fallbacks is fatal for the worker retry loop.
  if (/\[gate 4 error\]|\[gate 6 error\]|pipeline failed/.test(text)) return true;
  return false;
}

export function shouldAutoRetryJob(error: unknown, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (isFatalPipelineError(error)) return false;
  if (error instanceof WorkerWatchdogError) return false;
  return isTransientNetworkError(error);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export type HeavyPipelineJobContext = {
  trackId: string;
  userId: string;
  attempt: number;
  signal: AbortSignal;
  registerTempPath: (path: string) => void;
};

/**
 * Run heavy audio work under: slot lock → heartbeat → watchdog → try/catch/finally.
 * Releases the slot and purges temps even when hooks or work throw.
 */
export async function runHeavyPipelineJob<T>(input: {
  trackId: string;
  userId: string;
  work: (ctx: HeavyPipelineJobContext) => Promise<T>;
  watchdogMs?: number;
  maxAttempts?: number;
}): Promise<T> {
  ensurePipelineWorkerInstalled();

  const trackId = input.trackId.trim();
  const userId = input.userId;
  const watchdogMs = input.watchdogMs ?? PIPELINE_WATCHDOG_MS;
  const maxAttempts = Math.max(1, (input.maxAttempts ?? MAX_TRANSIENT_RETRIES) + 1);

  const release = await acquireHeavySlot();
  const abort = new AbortController();
  const tempPaths = new Set<string>();
  const job: InFlightJob = {
    trackId,
    userId,
    startedAt: Date.now(),
    attempt: 0,
    abort,
    tempPaths,
  };
  inFlight.set(trackId, job);

  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  try {
    await touchHeartbeat(trackId, userId);
    heartbeatTimer = setInterval(() => {
      void touchHeartbeat(trackId, userId);
    }, WORKER_HEARTBEAT_MS);
    // Unref so heartbeats never keep the process alive alone.
    heartbeatTimer.unref?.();

    const runAttempts = async (): Promise<T> => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        job.attempt = attempt;
        if (abort.signal.aborted) {
          throw new Error("Pipeline job aborted (shutdown or watchdog).");
        }
        try {
          console.log(
            `[Worker] slot acquired track=${trackId} attempt=${attempt}/${maxAttempts} slots=${activeSlots}/${HEAVY_PIPELINE_SLOTS}`,
          );
          return await input.work({
            trackId,
            userId,
            attempt,
            signal: abort.signal,
            registerTempPath: (path) => registerWorkerTempPathForTrack(trackId, path),
          });
        } catch (error) {
          lastError = error;
          if (!shouldAutoRetryJob(error, attempt, maxAttempts)) {
            throw error;
          }
          const backoff = Math.min(8_000, 500 * 2 ** (attempt - 1));
          console.warn(
            `[Worker] transient retry track=${trackId} attempt=${attempt} in ${backoff}ms: ${errorMessage(error)}`,
          );
          await sleep(backoff);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(errorMessage(lastError));
    };

    try {
      return await withTimeout(runAttempts(), watchdogMs, "Pipeline worker watchdog");
    } catch (error) {
      const msg = errorMessage(error);
      if (/Pipeline worker watchdog timed out/i.test(msg)) {
        abort.abort();
        throw new WorkerWatchdogError(watchdogMs);
      }
      throw error;
    }
  } catch (error) {
    await markJobFailed(trackId, userId, errorMessage(error));
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    inFlight.delete(trackId);
    await Promise.all([...tempPaths].map((p) => purgePath(p)));
    try {
      release();
    } catch (releaseErr) {
      console.warn(`[Worker] slot release failed: ${errorMessage(releaseErr)}`);
    }
    console.log(`[Worker] slot freed track=${trackId} active=${activeSlots}`);
  }
}

async function failAllInFlight(reason: string): Promise<void> {
  const jobs = [...inFlight.values()];
  for (const job of jobs) {
    try {
      job.abort.abort();
    } catch {
      /* ignore */
    }
    await markJobFailed(job.trackId, job.userId, reason);
    await Promise.all([...job.tempPaths].map((p) => purgePath(p)));
  }
  inFlight.clear();
}

async function onProcessShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[Worker] ${signal} — failing in-flight jobs and purging /tmp orphans`);
  while (slotWaiters.length) {
    const w = slotWaiters.shift();
    if (!w) break;
    clearTimeout(w.timer);
    w.reject(new WorkerSlotBusyError("Server is shutting down."));
  }
  await failAllInFlight(`Worker received ${signal}`);
  await cleanupOrphanTempFiles({ maxAgeMs: 0 });
}

/** Idempotent — install SIGTERM/SIGINT handlers + boot orphan sweep. */
export function ensurePipelineWorkerInstalled(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;

  try {
    // SIGTERM/SIGINT are owned by execute-pipeline `installPipelineOsGuards`
    // (process.once → cleanupActiveSlot → exit). Keep beforeExit + boot sweep here.
    process.on("beforeExit", () => {
      void cleanupOrphanTempFiles({ maxAgeMs: 0 });
    });
  } catch {
    /* ignore environments without signal support */
  }

  void cleanupOrphanTempFiles().then((n) => {
    if (n > 0) console.log(`[Worker] boot cleanup removed ${n} orphan temp path(s)`);
  });

  // Periodic stale-heartbeat sweep (process-local + DB touch).
  const sweeper = setInterval(() => {
    void sweepStaleProcessingJobs();
  }, STALE_HEARTBEAT_MS);
  sweeper.unref?.();
}

/**
 * Mark DB rows stuck in `processing` without a recent heartbeat as failed.
 * Only affects rows this process can see via admin client; safe no-op without keys.
 */
export async function sweepStaleProcessingJobs(): Promise<number> {
  let swept = 0;
  await runSafeHook("sweep stale processing", async () => {
    const { createEngineSupabaseClient } = await import("@/lib/engine-pipeline.server");
    const supabase = createEngineSupabaseClient();
    if (!supabase) return;
    const cutoff = new Date(Date.now() - STALE_HEARTBEAT_MS).toISOString();
    const { data, error } = await supabase
      .from("generation_tasks")
      .select("id, user_id")
      .eq("status", "processing")
      .lt("updated_at", cutoff)
      .limit(50);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      // Skip jobs still alive in this process.
      if (inFlight.has(row.id)) continue;
      await markJobFailed(
        row.id,
        row.user_id ?? "system",
        "Stale worker heartbeat — runner presumed dead",
      );
      swept += 1;
    }
  });
  return swept;
}

export function forceReleaseHeavySlots(): void {
  activeSlots = 0;
  while (slotWaiters.length) {
    const w = slotWaiters.shift();
    if (!w) break;
    clearTimeout(w.timer);
    w.reject(new WorkerSlotBusyError("Worker slot released on process exit."));
  }
}

/** Alias used by execute-pipeline OS exit traps. */
export function releaseWorkerSlot(): void {
  forceReleaseHeavySlots();
  for (const job of inFlight.values()) {
    try {
      job.abort.abort();
    } catch {
      /* ignore */
    }
  }
  inFlight.clear();
}

export async function purgeTempBuffers(): Promise<number> {
  return cleanupOrphanTempFiles({ maxAgeMs: 0 });
}

/** Test helpers */
export function __resetPipelineWorkerForTests(): void {
  activeSlots = 0;
  slotWaiters.length = 0;
  inFlight.clear();
  orphanTempPaths.clear();
  shuttingDown = false;
}

export function __workerDebugState() {
  return {
    activeSlots,
    waiting: slotWaiters.length,
    inFlight: [...inFlight.keys()],
    orphanTemps: orphanTempPaths.size,
    shuttingDown,
  };
}
