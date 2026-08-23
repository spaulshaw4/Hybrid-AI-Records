/**
 * Studio-stage circuit breaker.
 *
 * Counts consecutive network / 5xx failures per stage. After 3, the stage
 * fails immediately for 30s so the UI can release instead of hanging on a
 * dead vendor. Success resets the counter. 4xx (except 429) does not trip.
 */

import {
  PIPELINE_STAGES,
  PipelineBreakerOpenError,
  type PipelineStageId,
} from "@/lib/pipeline-contracts";

export const PIPELINE_BREAKER_THRESHOLD = 3;
export const PIPELINE_BREAKER_COOLDOWN_MS = 30_000;

type BreakerEntry = {
  failures: number;
  openedAt: number;
  lastReason: string | null;
};

const registry = new Map<PipelineStageId, BreakerEntry>();

function entry(stage: PipelineStageId): BreakerEntry {
  let found = registry.get(stage);
  if (!found) {
    found = { failures: 0, openedAt: 0, lastReason: null };
    registry.set(stage, found);
  }
  return found;
}

export function isTripWorthyFailure(status?: number | null, error?: unknown): boolean {
  if (typeof status === "number") {
    if (status >= 500) return true;
    if (status === 429) return true;
  }
  if (!error) return false;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "GenerationAbortedError") return false;
  if (/canceled|cancelled/i.test(error.message)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /failed to fetch|network|econnreset|enotfound|etimedout|socket/i.test(error.message);
}

export function isPipelineBreakerOpen(stage: PipelineStageId, now = Date.now()): boolean {
  const state = registry.get(stage);
  if (!state || state.openedAt === 0) return false;
  if (now - state.openedAt >= PIPELINE_BREAKER_COOLDOWN_MS) {
    state.openedAt = 0;
    return false;
  }
  return true;
}

export function assertPipelineBreakerClosed(stage: PipelineStageId): void {
  if (!isPipelineBreakerOpen(stage)) return;
  console.warn(
    `[CIRCUIT OPEN] ${PIPELINE_STAGES[stage].label}: cooling down ${PIPELINE_BREAKER_COOLDOWN_MS / 1000}s`,
  );
  throw new PipelineBreakerOpenError(stage);
}

export function recordPipelineSuccess(stage: PipelineStageId): void {
  registry.delete(stage);
}

export function recordPipelineFailure(
  stage: PipelineStageId,
  error?: unknown,
  status?: number | null,
): void {
  if (!isTripWorthyFailure(status, error)) return;
  const state = entry(stage);
  state.failures += 1;
  state.lastReason =
    (typeof status === "number" ? `HTTP ${status}` : null) ||
    (error instanceof Error ? error.message : String(error ?? "error"));
  if (state.failures >= PIPELINE_BREAKER_THRESHOLD && state.openedAt === 0) {
    state.openedAt = Date.now();
    console.error("[CIRCUIT OPEN]", {
      stage,
      failures: state.failures,
      reason: state.lastReason,
      cooldownMs: PIPELINE_BREAKER_COOLDOWN_MS,
    });
  }
}

export function recordPipelineHttp(stage: PipelineStageId, status: number, error?: unknown): void {
  if (status >= 200 && status < 400) {
    recordPipelineSuccess(stage);
    return;
  }
  recordPipelineFailure(stage, error, status);
}

export function pipelineBreakerSnapshot(now = Date.now()) {
  return (Object.keys(PIPELINE_STAGES) as PipelineStageId[]).map((stage) => {
    const state = registry.get(stage);
    const open = isPipelineBreakerOpen(stage, now);
    return {
      stage,
      open,
      failures: state?.failures ?? 0,
      retryAfterMs:
        open && state?.openedAt
          ? Math.max(0, PIPELINE_BREAKER_COOLDOWN_MS - (now - state.openedAt))
          : 0,
      lastReason: state?.lastReason ?? null,
    };
  });
}

export function resetPipelineBreakers(): void {
  registry.clear();
}
