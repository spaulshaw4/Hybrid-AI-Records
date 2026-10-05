/**
 * Local CPU Worker (api/headless_job_runner.py on 127.0.0.1:8880).
 *
 * AudioStudio Gate 1 otherwise posts to AIMusicAPI. When this URL is set
 * (default in non-production), create/poll/stream stay on the workstation.
 */

import { applyEngineControlsToPrompt, type EngineControls } from "@/lib/engine-controls";
import { clampDurationPreset } from "@/lib/track-length";
import { LYRICS_MAX_CHARS, LYRICS_TOO_LONG_MESSAGE, formatValidationError } from "@/lib/validation-error";

export const HYBRID_WORKER_PORT = 8880;
export const DEFAULT_HYBRID_WORKER_URL = `http://127.0.0.1:${HYBRID_WORKER_PORT}`;
/** Vite / leftover Next / old worker ports — never the live Python listener. */
export const FRONTEND_DEV_PORTS = new Set(["3000", "8000", "8080", "8082", "5173"]);
/** Headless generate + optional master can exceed the 120s AIMusicAPI poll. */
export const LOCAL_WORKER_TIMEOUT_MS = 8 * 60_000;
/** One master per Generate click. The worker does not render candidate batches. */
export const SINGLE_TRACK_OUTPUTS = 1;
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

/** Last path segment of a worker stream URL, without a query string. */
function streamFileName(url: string): string {
  const path = url.split("?")[0]?.split("#")[0] ?? "";
  const name = path.split("/").pop() || "";
  try {
    return decodeURIComponent(name).trim();
  } catch {
    return name.trim();
  }
}

/**
 * Gate 1 streams the Lyria master. A 48 kHz WAV on ``master_url`` wins over
 * an MP3 filename so the circuit breaker opens the WAV, not a missing path.
 */
function gate1StreamFile(job: Record<string, unknown>): string {
  const masterName = streamFileName(String(job.master_url || ""));
  const named = String(job.audio_filename || "").trim();
  if (masterName.toLowerCase().endsWith(".wav")) return masterName;
  if (named.toLowerCase().endsWith(".wav")) return named;
  return named;
}

function workerAuthHeaders(json = true): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  const token = (process.env.HYBRID_WORKER_TOKEN || "").trim();
  if (token) headers["X-Hybrid-Worker-Token"] = token;
  return headers;
}

async function vocalBytesFromInput(input: {
  vocalFile?: Buffer | Uint8Array;
  vocalAudioBase64?: string;
  referenceAudioUrl?: string;
}): Promise<{ bytes: Buffer; fileName: string } | null> {
  if (input.vocalFile && input.vocalFile.byteLength > 64) {
    return { bytes: Buffer.from(input.vocalFile), fileName: "vocal.webm" };
  }
  const b64 = (input.vocalAudioBase64 || "").trim();
  if (b64) {
    const bytes = Buffer.from(b64, "base64");
    if (bytes.byteLength > 64) return { bytes, fileName: "mic_take.webm" };
  }
  const url = (input.referenceAudioUrl || "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength < 64) return null;
    const name = url.split("/").pop()?.split("?")[0] || "vocal.webm";
    return { bytes, fileName: name };
  } catch {
    return null;
  }
}

/** Default render length when the studio sends no duration (3:30). */
export const DEFAULT_WORKER_DURATION_SECONDS = 210;
export const DEFAULT_WORKER_BPM = 110;

/**
 * Style textarea plus slider directives. Lyria only receives a prompt string,
 * so tempo, adherence, style lock, and temperature have to travel inside it.
 */
export function composeWorkerStylePrompt(
  tags: string | undefined,
  style: string | undefined,
  controls?: EngineControls,
): string {
  const stylePrompt = [tags, style]
    .map((part) => (part || "").trim())
    .filter((part, index, all) => part.length > 0 && all.indexOf(part) === index)
    .join("\n")
    .slice(0, 6000);
  if (!controls) return stylePrompt;
  return applyEngineControlsToPrompt(stylePrompt, controls).slice(0, 6000);
}

/** 4/4 bars for a target length: bars = round(seconds * bpm / 240). */
export function barsForDuration(seconds: number, bpm: number): number {
  return Math.max(4, Math.min(256, Math.round((seconds * bpm) / 240)));
}

export type HybridVocalMode = "lead" | "adlib" | "none";

export async function generateFromHybridWorker(input: {
  prompt: string;
  genreHint?: string;
  durationSeconds?: number;
  /** Preset seconds sent as ``duration`` on POST /api/tracks/create. */
  duration?: number;
  bpm?: number;
  instrumental?: boolean;
  /** Style prompt. Studio also sends the Style Prompt textarea as ``tags``. */
  style?: string;
  tags?: string;
  lyrics?: string;
  key?: string;
  controls?: EngineControls;
  vocalFile?: Buffer | Uint8Array;
  vocalAudioBase64?: string;
  vocalFileName?: string;
  referenceAudioUrl?: string;
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
  if (prompt.length < 50) {
    throw new Error("Prompt must be at least 50 characters.");
  }
  if (prompt.length > 5000) {
    throw new Error("prompt exceeds 5000 characters");
  }
  console.log("[HYBRID_WORKER] routing Gate 1 to", base);

  const bpmRaw = Number(input.bpm);
  const bpm = Number.isFinite(bpmRaw) && bpmRaw >= 60 && bpmRaw <= 200 ? bpmRaw : DEFAULT_WORKER_BPM;
  const secondsRaw = Number(input.duration ?? input.durationSeconds);
  const durationSeconds = clampDurationPreset(
    Number.isFinite(secondsRaw) ? secondsRaw : DEFAULT_WORKER_DURATION_SECONDS,
  );
  const bars = barsForDuration(durationSeconds, bpm);
  const vocalMode: HybridVocalMode = input.instrumental
    ? "none"
    : (input.lyrics || "").trim()
      ? "lead"
      : "adlib";
  const vocal = input.instrumental ? null : await vocalBytesFromInput(input);
  console.log("[HYBRID_WORKER] length", {
    durationSeconds,
    bpm,
    bars,
    vocalMode,
    vocalBytes: vocal?.bytes.byteLength ?? 0,
  });

  // Multipart — do NOT set Content-Type; fetch supplies the boundary.
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("title", prompt.slice(0, 120));
  form.append("genre", (input.genreHint || "").trim());
  form.append("genre_hint", (input.genreHint || "").trim());
  form.append("bpm", String(bpm));
  form.append("bars", String(bars));
  form.append("duration", String(durationSeconds));
  form.append("duration_sec", String(durationSeconds));
  form.append("vocal_mode", vocalMode);
  form.append("key", (input.key || "").trim() || "G");
  form.append("num_outputs", String(SINGLE_TRACK_OUTPUTS));
  const stylePrompt = composeWorkerStylePrompt(input.tags, input.style, input.controls);
  const lyricText = input.instrumental ? "" : (input.lyrics || "").trim();
  if (lyricText.length > LYRICS_MAX_CHARS) {
    throw new Error(LYRICS_TOO_LONG_MESSAGE);
  }
  if (stylePrompt) form.append("style", stylePrompt);
  if (lyricText) form.append("lyrics", lyricText);
  form.append("tempo", String(bpm));
  if (input.controls) {
    form.append("weirdness", String(input.controls.weirdness));
    form.append("audio_influence", String(input.controls.influence));
    if (input.controls.styleInfluence != null) {
      form.append("style_influence", String(input.controls.styleInfluence));
    }
  }
  if (vocal && vocal.bytes.byteLength > 64) {
    form.append(
      "voice_sample",
      new Blob([new Uint8Array(vocal.bytes)], { type: "audio/wav" }),
      "recording.wav",
    );
    console.log("[HYBRID_WORKER] appended voice_sample recording.wav", vocal.bytes.byteLength);
  } else {
    console.log("[HYBRID_WORKER] no voice_sample on this generate");
  }
  let created: Response | undefined;
  let lastFetchError = "";
  for (const path of ["/generate", "/api/tracks/create"]) {
    try {
      created = await fetch(`${base}${path}`, {
        method: "POST",
        headers: workerAuthHeaders(false),
        body: form,
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
    const detail = formatValidationError(createdBody, `HTTP ${created.status}`);
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
      filename = gate1StreamFile(job);
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
  if (!(buffer.byteLength > 100 * 1024)) {
    console.error("[HYBRID_WORKER] empty mix", filename, buffer.byteLength);
    throw new Error("[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.");
  }
  console.log(
    `[HANDOFF] generation -> composition hybrid_worker session=${sessionId} bytes=${buffer.byteLength}`,
  );
  return { sessionId, filename, audioUrl, buffer };
}
