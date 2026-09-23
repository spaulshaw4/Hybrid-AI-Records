/**
 * Local CPU Worker (api/headless_job_runner.py on 127.0.0.1:8880).
 *
 * AudioStudio Gate 1 otherwise posts to AIMusicAPI. When this URL is set
 * (default in non-production), create/poll/stream stay on the workstation.
 */

export const HYBRID_WORKER_PORT = 8880;
export const DEFAULT_HYBRID_WORKER_URL = `http://127.0.0.1:${HYBRID_WORKER_PORT}`;
/** Vite / leftover Next / old worker ports — never the live Python listener. */
export const FRONTEND_DEV_PORTS = new Set(["3000", "8000", "8080", "8082", "5173"]);
/** Headless generate + optional master can exceed the 120s AIMusicAPI poll. */
export const LOCAL_WORKER_TIMEOUT_MS = 8 * 60_000;
const POLL_MS = 2_000;

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Map a UI / legacy worker origin back to the FastAPI listener on :8880. */
export function canonicalizeWorkerUrl(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (isLoopbackHost(parsed.hostname) && FRONTEND_DEV_PORTS.has(parsed.port)) {
    parsed.port = String(HYBRID_WORKER_PORT);
    return parsed.toString().replace(/\/$/, "");
  }
  return trimmed;
}

export type HybridWorkerTrack = {
  sessionId: string;
  filename: string;
  audioUrl: string;
  buffer: Buffer;
};

function trimUrl(value: string | undefined): string | null {
  const next = (value || "").trim().replace(/\/$/, "");
  if (!next || next === "0" || next.toLowerCase() === "off") return null;
  return canonicalizeWorkerUrl(next);
}

export function hybridWorkerUrl(): string | null {
  if (process.env.HYBRID_WORKER_URL !== undefined) {
    return trimUrl(process.env.HYBRID_WORKER_URL);
  }
  const vite = trimUrl(process.env.VITE_HYBRID_WORKER_URL);
  if (vite) return vite;
  if (process.env.NODE_ENV === "production") return null;
  return DEFAULT_HYBRID_WORKER_URL;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

function workerAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = (process.env.HYBRID_WORKER_TOKEN || "").trim();
  if (token) headers["X-Hybrid-Worker-Token"] = token;
  return headers;
}

/** Default render length when the studio sends no duration (3:30). */
export const DEFAULT_WORKER_DURATION_SECONDS = 210;
export const DEFAULT_WORKER_BPM = 110;

/** 4/4 bars for a target length: bars = round(seconds * bpm / 240). */
export function barsForDuration(seconds: number, bpm: number): number {
  return Math.max(4, Math.min(256, Math.round((seconds * bpm) / 240)));
}

export type HybridVocalMode = "lead" | "adlib" | "none";

export async function generateFromHybridWorker(input: {
  prompt: string;
  genreHint?: string;
  durationSeconds?: number;
  bpm?: number;
  instrumental?: boolean;
  lyrics?: string;
}): Promise<HybridWorkerTrack> {
  const base = hybridWorkerUrl();
  if (!base) {
    throw new Error("[Circuit Breaker] Gate 1 failed: HYBRID_WORKER_URL is off.");
  }
  const prompt = (input.prompt || "").trim();
  if (!prompt) {
    throw new Error(
      "[Circuit Breaker] Gate 1 failed: API payload dropped prompt/style — nothing to generate.",
    );
  }
  console.log("[HYBRID_WORKER] routing Gate 1 to", base);

  const bpmRaw = Number(input.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw >= 60 && bpmRaw <= 200 ? bpmRaw : DEFAULT_WORKER_BPM;
  const secondsRaw = Number(input.durationSeconds);
  const durationSeconds =
    Number.isFinite(secondsRaw) && secondsRaw >= 10 ? secondsRaw : DEFAULT_WORKER_DURATION_SECONDS;
  const bars = barsForDuration(durationSeconds, bpm);
  const vocalMode: HybridVocalMode = input.instrumental
    ? "none"
    : (input.lyrics || "").trim()
      ? "lead"
      : "adlib";
  console.log("[HYBRID_WORKER] length", { durationSeconds, bpm, bars, vocalMode });

  const payload = JSON.stringify({
    prompt: prompt.slice(0, 2000),
    genre_hint: (input.genreHint || "").trim() || undefined,
    bpm,
    bars,
    duration_sec: durationSeconds,
    vocal_mode: vocalMode,
  });
  let created: Response | undefined;
  let lastFetchError = "";
  for (const path of ["/generate", "/api/tracks/create"]) {
    try {
      created = await fetch(`${base}${path}`, {
        method: "POST",
        headers: workerAuthHeaders(),
        body: payload,
      });
      if (created.status !== 404) {
        console.log("[HYBRID_WORKER] posted", `${base}${path}`, created.status);
        break;
      }
    } catch (err) {
      lastFetchError = err instanceof Error ? err.message : String(err);
      console.error("[HYBRID_WORKER] create fetch failed", `${base}${path}`, lastFetchError);
    }
  }
  if (!created) {
    throw new Error(
      `[Circuit Breaker] Gate 1 failed: local worker unreachable at ${base} (${lastFetchError})`,
    );
  }

  const createdBody = await readJson(created);
  if (!created.ok) {
    const detail =
      typeof createdBody.detail === "string"
        ? createdBody.detail
        : `HTTP ${created.status}`;
    console.error("[HYBRID_WORKER] create rejected", created.status, detail);
    throw new Error(`[Circuit Breaker] Gate 1 failed: ${detail}`);
  }
  const sessionId = String(createdBody.session_id || "").trim();
  if (!sessionId) {
    throw new Error("[Circuit Breaker] Gate 1 failed: Worker create returned no session_id.");
  }
  console.log("[HYBRID_WORKER] queued", sessionId);

  const deadline = Date.now() + LOCAL_WORKER_TIMEOUT_MS;
  let filename = "";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    let statusRes: Response;
    try {
      statusRes = await fetch(`${base}/api/tracks/status/${encodeURIComponent(sessionId)}`, {
        headers: workerAuthHeaders(),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error("[HYBRID_WORKER] status fetch failed", sessionId, detail);
      throw new Error(
        `[Circuit Breaker] Gate 1 failed: lost Worker at ${base} (${detail})`,
      );
    }
    const job = await readJson(statusRes);
    const status = String(job.status || "").toLowerCase();
    if (status === "failed") {
      const error = String(job.error || job.detail || "Worker job failed.");
      console.error("[HYBRID_WORKER] job failed", sessionId, error);
      throw new Error(`[Circuit Breaker] Gate 1 failed: ${error}`);
    }
    if (status === "completed") {
      filename = String(job.audio_filename || "").trim();
      break;
    }
  }
  if (!filename) {
    throw new Error(
      `[Circuit Breaker] Gate 1 (local Hybrid worker) timed out after ${LOCAL_WORKER_TIMEOUT_MS / 1000}s`,
    );
  }

  const audioUrl = `${base}/api/stream/${encodeURIComponent(filename)}`;
  let audioRes: Response;
  try {
    audioRes = await fetch(audioUrl, { headers: workerAuthHeaders() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[HYBRID_WORKER] stream fetch failed", audioUrl, detail);
    throw new Error(
      `[Circuit Breaker] Gate 1 failed: Worker mix missing at ${audioUrl} (${detail})`,
    );
  }
  if (!audioRes.ok) {
    throw new Error(
      `[Circuit Breaker] Gate 1 failed: Worker stream HTTP ${audioRes.status} for ${filename}`,
    );
  }
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  if (buffer.byteLength < 4096) {
    console.error("[HYBRID_WORKER] empty mix", filename, buffer.byteLength);
    throw new Error("[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.");
  }
  console.log(
    `[HANDOFF] generation -> composition hybrid_worker session=${sessionId} bytes=${buffer.byteLength}`,
  );
  return { sessionId, filename, audioUrl, buffer };
}
