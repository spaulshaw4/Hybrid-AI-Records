/**
 * Sonic studio generation (MusicAPI / AIMusicAPI).
 *
 * Two-step workflow: POST /sonic/create, then poll GET /sonic/task/{id}
 * until `data.status` is succeeded or failed.
 *
 * Primary host is `api.musicapi.ai` (active MusicAPI credits). Fallback host is
 * `api.aimusicapi.ai`. Auth is Bearer (`Authorization: Bearer ${apiKey}`).
 * Custom-mode body: lyrics in `prompt`, style in `tags`, model locked to
 * `mv: "sonic-v5"`.
 *
 * Selected gender is appended to `tags` and sent as `vocal_gender` (`m`/`f`)
 * only when the artist picks one — never null or empty string.
 *
 * Server-only: imported from `generateEngineTrack` (`createServerFn` handler).
 * Reads Node `process.env`; never import this from client components.
 */

import { readEnv, requireStageKey } from "@/lib/env";
import {
  abortableDelay,
  isGenerationAborted,
  mergeAbortSignals,
  throwIfAborted,
} from "@/lib/generation-abort";
import {
  assertPipelineBreakerClosed,
  recordPipelineFailure,
  recordPipelineHttp,
  recordPipelineSuccess,
} from "@/lib/pipeline-breaker";
import {
  PIPELINE_PROGRESS,
  reportPipelineProgress,
  type StudioProgressCallback,
} from "@/lib/pipeline-progress";
import {
  assertBaseAudioContractInput,
  assertBaseAudioContractOutput,
  isFailEarlyGuardError,
  isHttpAudioUrl,
  isPipelineBreakerOpenError,
  logGateCleared,
  logPostConditionPassed,
  logPreConditionPassed,
  type BaseAudioContract,
} from "@/lib/pipeline-contracts";
import { logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";
import { assertLyricsGate, probeAudioUrlReachable } from "@/lib/studio-pipeline-gates";
import { logFailedStudioGate, StudioPipelineError } from "@/lib/studio-pipeline-error";

/** MusicAPI host — separate vendor, separate key from AIMusicAPI. */
export const MUSICAPI_BASE_URL = "https://api.musicapi.ai";
/** AIMusicAPI host — where the configured AIMUSICAPI_KEY is valid. */
export const AIMUSICAPI_BASE_URL = "https://api.aimusicapi.ai";
/** MusicAPI Sonic create endpoint. */
export const MUSICAPI_CREATE_URL = `${MUSICAPI_BASE_URL}/api/v1/sonic/create`;
/** AIMusicAPI Sonic create endpoint. */
export const AIMUSICAPI_CREATE_URL = `${AIMUSICAPI_BASE_URL}/api/v1/sonic/create`;
/** MusicAPI Sonic task poll base (append /${taskId}). */
export const MUSICAPI_TASK_URL = `${MUSICAPI_BASE_URL}/api/v1/sonic/task`;
/** AIMusicAPI Sonic task poll base. */
export const AIMUSICAPI_TASK_URL = `${AIMUSICAPI_BASE_URL}/api/v1/sonic/task`;
/**
 * Create and poll must target the same host: a task id minted by one vendor is
 * meaningless to the other. AIMusicAPI is primary because that is the account
 * the configured key belongs to.
 */
export const SONIC_PRIMARY_CREATE_URL = AIMUSICAPI_CREATE_URL;
export const SONIC_FALLBACK_CREATE_URL = MUSICAPI_CREATE_URL;
export const SONIC_PRIMARY_TASK_URL = AIMUSICAPI_TASK_URL;
export const SONIC_FALLBACK_TASK_URL = MUSICAPI_TASK_URL;
/** Canonical create URL (primary). */
export const SONIC_CREATE_URL = SONIC_PRIMARY_CREATE_URL;
/** Canonical task URL (primary). */
export const SONIC_TASK_URL = SONIC_PRIMARY_TASK_URL;
/** @deprecated Alias for create URL. */
export const SUNO_CREATE_URL = SONIC_PRIMARY_CREATE_URL;
/** @deprecated Alias for task URL. */
export const SUNO_TASK_URL = SONIC_PRIMARY_TASK_URL;
/** Official MusicAPI / AIMusicAPI auth scheme. */
export const AIMUSICAPI_HEADER_FORMAT = "Authorization: Bearer";
/** Minimum abort window for Sonic create + poll HTTP calls. */
export const AIMUSICAPI_FETCH_TIMEOUT_MS = 60_000;
/** Locked Sonic v5 model id. MusicAPI names its v5 model this way. */
export const SONIC_MODEL = "sonic-v5" as const;
/**
 * AIMusicAPI's equivalent of Sonic v5. Only the `chirp-*` names accept
 * `vocal_gender` there, so the model id has to follow the host.
 */
export const AIMUSICAPI_MODEL = "chirp-v5" as const;
/** @deprecated Use SONIC_MODEL. */
export const SUNO_MODEL = SONIC_MODEL;

export function sonicModelForHost(endpoint: string): string {
  return endpoint.startsWith(AIMUSICAPI_BASE_URL) ? AIMUSICAPI_MODEL : SONIC_MODEL;
}

export type SonicModel = typeof SONIC_MODEL;

export type StudioTrackOptions = {
  genre?: string;
  subGenre?: string;
  mood?: string;
  bpm?: number | string;
  instruments?: string[];
  vocalTimbre?: string;
  vocalGender?: string;
  vocal_gender?: string;
  lyrics?: string;
  /** Pre-built Sonic tags (style / genre chips). Falls back to styleTags(). */
  tags?: string;
  title?: string;
  isInstrumental?: boolean;
  /** Ignored — every dispatch is locked to `sonic-v5`. */
  mv?: string;
  onProgress?: StudioProgressCallback;
  abortSignal?: AbortSignal;
};

export type StudioTrackHooks = {
  onProgress?: StudioProgressCallback;
  abortSignal?: AbortSignal;
};

export type SonicVocalGender = "f" | "m";

/** Strict MusicAPI Sonic v5 create body. */
export type SonicCreatePayload = {
  custom_mode: true;
  mv: typeof SONIC_MODEL;
  prompt: string;
  tags: string;
  title: string;
  vocal_gender?: SonicVocalGender;
};

export type StudioTrackStart = {
  taskId: string;
  payload: SonicCreatePayload;
  status: "processing";
};

export type StudioTrackResult = {
  taskId: string;
  status: "completed" | "failed" | "processing";
  audioUrl: string | null;
  imageUrl: string | null;
  title: string | null;
  duration: number | null;
  /** Upstream clip / track ids when the provider returns them. */
  trackIds: string[];
  /** Raw provider status string (e.g. running, queued, succeeded). */
  rawStatus: string | null;
  /** Number of clips the task returned, for poll diagnostics. */
  clipCount: number;
};

const MUSIC_STAGE = "MusicAPI (Base Arrangement)" as const;

function trimProcessEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * Preferred names first, then historic aliases, then ENGINE_API_KEY last
 * so a Replicate token is not used when a music-specific key exists.
 * `readEnv` also resolves the `VITE_`-prefixed variant of each name.
 *
 * Browser clients must never require these keys — generate goes through
 * `generateEngineTrack` / `postSonicCreate` on the server.
 */
export function getMusicApiKey(): string {
  const apiKey =
    trimProcessEnv("AIMUSICAPI_KEY") ||
    trimProcessEnv("MUSICAPI_KEY") ||
    trimProcessEnv("MUSIC_API_KEY") ||
    trimProcessEnv("AI_MUSIC_API_KEY") ||
    readEnv("AIMUSICAPI_KEY") ||
    readEnv("MUSICAPI_KEY") ||
    readEnv("MUSIC_API_KEY") ||
    readEnv("AI_MUSIC_API_KEY") ||
    readEnv("AIMUSIC_API_KEY") ||
    trimProcessEnv("ENGINE_API_KEY");
  if (!apiKey) {
    console.error(
      "[MUSICAPI] AIMUSICAPI_KEY / MUSICAPI_KEY / MUSIC_API_KEY is undefined — add it to .env.local (server), not only a VITE_ client key",
    );
    return requireStageKey("MUSIC_API_KEY", MUSIC_STAGE);
  }
  return apiKey;
}

function musicApiKeyPrefix(apiKey: string | undefined): string {
  return apiKey ? `${apiKey.slice(0, 8)}...` : "NONE_FOUND";
}

function logAimusicRequest(targetUrl: string, apiKey: string | undefined): void {
  console.log("[AIMUSICAPI] Target URL:", targetUrl);
  console.log("[AIMUSICAPI] Using key prefix:", musicApiKeyPrefix(apiKey));
  console.log("[AIMUSICAPI] Header format:", AIMUSICAPI_HEADER_FORMAT);
}

export function musicApiKey(): string {
  return getMusicApiKey();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readTaskId(body: unknown): string | null {
  const row = asRecord(body);
  if (!row) return null;
  const nested = asRecord(row.data);
  const id = row.task_id ?? row.taskId ?? nested?.task_id ?? nested?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function asAudioUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = asAudioUrl(item);
      if (url) return url;
    }
    return null;
  }
  const row = asRecord(value);
  if (!row) return null;
  return asAudioUrl(row.audio_url ?? row.audioUrl ?? row.url ?? row.output);
}

const TERMINAL_SUCCESS_STATUSES = ["succeeded", "success", "completed", "complete"];
const TERMINAL_FAILURE_STATUSES = ["failed", "fail", "error", "canceled", "cancelled"];

function dataRecords(body: unknown): Record<string, unknown>[] {
  const row = asRecord(body);
  if (!row) return [];
  const source = Array.isArray(row.data)
    ? row.data
    : Array.isArray(row.clips)
      ? row.clips
      : null;
  if (source) {
    return source.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => !!item);
  }
  const single = asRecord(row.data);
  return single ? [single] : [];
}

function firstDataRecord(body: unknown): Record<string, unknown> | null {
  return dataRecords(body)[0] ?? null;
}

function clipStatus(clip: Record<string, unknown>): string {
  return String(clip.status ?? clip.state ?? "").toLowerCase();
}

/** A clip that finished and carries playable audio. */
function succeededClip(body: unknown): Record<string, unknown> | null {
  return (
    dataRecords(body).find(
      (clip) => TERMINAL_SUCCESS_STATUSES.includes(clipStatus(clip)) && !!asAudioUrl(clip.audio_url),
    ) ?? null
  );
}

/**
 * Sonic returns two clips per task and they finish independently, so the first
 * clip's status is not the task's status. One finished clip is enough to hand
 * off to stems; only report failure when every clip has failed.
 */
function readTaskStatus(body: unknown): string {
  const row = asRecord(body);
  const clips = dataRecords(body);
  if (clips.length > 1) {
    if (succeededClip(body)) return "succeeded";
    const statuses = clips.map(clipStatus);
    if (statuses.every((status) => TERMINAL_FAILURE_STATUSES.includes(status))) return "failed";
    const pending = statuses.find((status) => status && !TERMINAL_FAILURE_STATUSES.includes(status));
    if (pending) return pending;
  }
  const data = clips[0];
  const raw = data?.status ?? data?.state ?? row?.status ?? row?.state ?? "";
  return String(raw).toLowerCase();
}

function readTaskDuration(body: unknown): number | null {
  const row = asRecord(body);
  const data = firstDataRecord(body);
  const raw = data?.duration ?? data?.duration_seconds ?? data?.durationSeconds ?? row?.duration;
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""));
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1000 ? Math.round(value / 1000) : value;
}

function readTrackIds(body: unknown, taskId: string): string[] {
  const ids = new Set<string>();
  if (taskId.trim()) ids.add(taskId.trim());
  const row = asRecord(body);
  const data = firstDataRecord(body);
  for (const source of [data, row]) {
    if (!source) continue;
    for (const key of ["id", "track_id", "trackId", "clip_id", "clipId", "song_id", "songId"]) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) ids.add(value.trim());
    }
    const tracks = source.tracks ?? source.clips ?? source.songs;
    if (Array.isArray(tracks)) {
      for (const item of tracks) {
        const track = asRecord(item);
        const id = track?.id ?? track?.track_id ?? track?.clip_id;
        if (typeof id === "string" && id.trim()) ids.add(id.trim());
      }
    }
  }
  return [...ids];
}

/**
 * AIMusicAPI, Suno and Sonic all report audio differently: top-level strings, a
 * `data` array of clips, a `clips` array, or an `output` object. Prefer a
 * finished clip's `audio_url` (a downloadable CDN file) over a `stream_url`,
 * which is a live pipe that stems and mastering cannot fetch.
 */
export function extractAudioUrl(result: unknown): string | null {
  const row = asRecord(result);
  if (!row) return null;

  const finished = succeededClip(result);
  if (finished) {
    const url = asAudioUrl(finished.audio_url ?? finished.source_url ?? finished.stream_url);
    if (url) return url;
  }

  const direct = asAudioUrl(row.audio_url ?? row.audioUrl ?? row.stream_url);
  if (direct) return direct;

  for (const clip of dataRecords(result)) {
    const url = asAudioUrl(
      clip.audio_url ?? clip.audioUrl ?? clip.source_url ?? clip.stream_url ?? clip.output,
    );
    if (url) return url;
  }

  if (Array.isArray(row.clips)) {
    for (const item of row.clips) {
      const clip = asRecord(item);
      if (!clip) continue;
      const url = asAudioUrl(clip.audio_url ?? clip.audioUrl ?? clip.stream_url);
      if (url) return url;
    }
  }

  return asAudioUrl(row.output);
}

function readTaskResult(body: unknown): {
  audioUrl: string | null;
  imageUrl: string | null;
  title: string | null;
  duration: number | null;
  status: "completed" | "failed" | "processing";
  rawStatus: string;
} {
  const row = asRecord(body);
  if (!row) {
    return {
      audioUrl: null,
      imageUrl: null,
      title: null,
      duration: null,
      status: "processing",
      rawStatus: "unknown",
    };
  }
  const data = firstDataRecord(body);
  const rawStatus = readTaskStatus(body) || "unknown";
  const audioUrl = extractAudioUrl(body);
  const duration = readTaskDuration(body);
  const imageUrl =
    (typeof data?.image_url === "string" && data.image_url) ||
    (typeof data?.imageUrl === "string" && data.imageUrl) ||
    (typeof row.image_url === "string" && row.image_url) ||
    (typeof row.imageUrl === "string" && row.imageUrl) ||
    null;
  const title =
    (typeof data?.title === "string" && data.title) ||
    (typeof row.title === "string" && row.title) ||
    null;

  if (
    rawStatus === "failed" ||
    rawStatus === "fail" ||
    rawStatus === "error" ||
    rawStatus === "canceled" ||
    rawStatus === "cancelled"
  ) {
    return { audioUrl: null, imageUrl, title, duration, status: "failed", rawStatus };
  }
  if (
    rawStatus === "succeeded" ||
    rawStatus === "success" ||
    rawStatus === "completed" ||
    rawStatus === "complete"
  ) {
    return {
      audioUrl,
      imageUrl,
      title,
      duration,
      status: audioUrl ? "completed" : "processing",
      rawStatus,
    };
  }
  if (audioUrl) {
    return { audioUrl, imageUrl, title, duration, status: "completed", rawStatus };
  }
  return { audioUrl: null, imageUrl, title, duration, status: "processing", rawStatus };
}

function styleTags(options: StudioTrackOptions): string {
  return [
    options.genre,
    options.subGenre,
    options.bpm ? `${options.bpm} BPM` : null,
    options.instruments?.length ? options.instruments.join(", ") : null,
    options.vocalTimbre || "raw acoustic studio recording",
  ]
    .filter(Boolean)
    .join(", ");
}

export function supportsVocalGender(mv: string = SONIC_MODEL): boolean {
  return mv === SONIC_MODEL;
}

/** Maps studio labels to Sonic `m`/`f`. Anything else is omitted. */
export function normalizeVocalGender(value: string | undefined): SonicVocalGender | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (raw === "f" || raw === "female") return "f";
  if (raw === "m" || raw === "male") return "m";
  return undefined;
}

function genderNegativeTags(gender: SonicVocalGender | undefined): string | undefined {
  if (gender === "f") return "male vocals, low baritone, synthpop, electronic dance";
  if (gender === "m") return "female vocals, soprano, synthpop, 80s dance pop, electronic synths, autotune";
  return undefined;
}

/** Drop undefined / null optional keys before the Suno POST. */
export function cleanSonicPayload<T extends Record<string, unknown>>(payload: T): T {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) as T;
}

function appendGenderTag(tags: string, gender: SonicVocalGender): string {
  const phrase = gender === "m" ? "male vocals" : "female vocals";
  if (tags.toLowerCase().includes(phrase)) return tags;
  return tags ? `${tags}, ${phrase}` : phrase;
}

/** Strict Sonic v5 create body — caller `mv` is ignored. */
export function buildSonicCreatePayload(options: StudioTrackOptions): SonicCreatePayload {
  const gender = normalizeVocalGender(options.vocal_gender || options.vocalGender);
  let tags = options.tags?.trim() || styleTags(options) || options.genre || "";
  if (gender) tags = appendGenderTag(tags, gender);

  const payload: SonicCreatePayload = {
    custom_mode: true,
    mv: SONIC_MODEL,
    prompt: options.lyrics ?? "",
    tags,
    title: options.title || "Studio Master",
  };

  if (gender) {
    payload.vocal_gender = gender;
  } else {
    delete payload.vocal_gender;
  }

  return cleanSonicPayload(payload);
}

function previewBody(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** True when MusicAPI rejected the model version (not auth / network). */
export function isInvalidMvRejection(status: number, raw: unknown): boolean {
  if (status === 401 || status === 403) return false;
  if (status < 400) return false;
  const text = previewBody(raw).toLowerCase();
  return (
    status === 400 ||
    status === 422 ||
    text.includes("mv field is invalid") ||
    text.includes("invalid model")
  );
}

function musicApiAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };
}

/** Masked key check — never logs enough of the key to be reusable. */
function logAuthDiagnostic(apiKey: string | undefined): void {
  const rawKey = apiKey?.trim() ?? "";
  const keyPreview = rawKey
    ? `${rawKey.slice(0, 4)}...${rawKey.slice(-4)} (length: ${rawKey.length})`
    : "MISSING/UNDEFINED";
  console.log("[AUTH_DIAGNOSTIC] Server Key Status:", keyPreview);
}

async function postSonicCreate(
  payload: SonicCreatePayload,
  apiKey: string,
  abortSignal?: AbortSignal,
): Promise<{ response: Response; raw: unknown; endpoint: string }> {
  const lyricsPrompt = payload.prompt;
  const styleTags = payload.tags;
  const trackTitle = payload.title;
  const vocalGender = normalizeVocalGender(payload.vocal_gender);

  const buildBody = (endpoint: string): Record<string, unknown> => ({
    custom_mode: true,
    mv: sonicModelForHost(endpoint),
    prompt: lyricsPrompt,
    tags: styleTags,
    title: trackTitle,
    ...(vocalGender ? { vocal_gender: vocalGender } : {}),
  });

  logAuthDiagnostic(apiKey);

  const endpoints = [SONIC_PRIMARY_CREATE_URL, SONIC_FALLBACK_CREATE_URL];
  let lastError: unknown = null;

  for (const endpoint of endpoints) {
    const dispatchPayload = buildBody(endpoint);
    console.log("[AIMUSICAPI_DISPATCH]", JSON.stringify(dispatchPayload, null, 2));
    console.log("[EXACT_OUTBOUND_BODY]", JSON.stringify(dispatchPayload, null, 2));
    logAimusicRequest(endpoint, apiKey);
    try {
      const response = await globalThis.fetch(endpoint, {
        method: "POST",
        headers: musicApiAuthHeaders(apiKey),
        body: JSON.stringify(dispatchPayload),
        signal: mergeAbortSignals(AIMUSICAPI_FETCH_TIMEOUT_MS, abortSignal),
      });
      console.log("[MUSICAPI_DISPATCH]", { url: endpoint, status: response.status });
      const responseText = await response.clone().text();
      console.log("[AIMUSICAPI_RESPONSE_STATUS]", response.status);
      console.log("[AIMUSICAPI_RESPONSE_BODY]", responseText);
      const raw = responseText
        ? (() => {
            try {
              return JSON.parse(responseText) as unknown;
            } catch {
              return responseText;
            }
          })()
        : null;

      // Fall back only on hard host/routing failures, not auth / validation errors.
      if (
        !response.ok &&
        endpoint === SONIC_PRIMARY_CREATE_URL &&
        (response.status === 404 || response.status === 502 || response.status === 503)
      ) {
        console.warn("[MUSICAPI_DISPATCH] primary host failed — trying MusicAPI fallback");
        lastError = new Error(`Primary MusicAPI create failed (${response.status})`);
        continue;
      }

      if (!response.ok) {
        console.error("[AIMUSICAPI_ERROR]", response.status, previewBody(raw));
      }
      return { response, raw, endpoint };
    } catch (error) {
      if (isGenerationAborted(error)) throw error;
      lastError = error;
      if (endpoint === SONIC_PRIMARY_CREATE_URL) {
        console.warn(
          "[MUSICAPI_DISPATCH] primary host unreachable — trying MusicAPI fallback",
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("MusicAPI create failed on all hosts");
}

export async function generateStudioTrack(
  options: StudioTrackOptions,
  hooks: StudioTrackHooks = {},
): Promise<StudioTrackStart> {
  const onProgress = hooks.onProgress ?? options.onProgress;
  const abortSignal = hooks.abortSignal ?? options.abortSignal;
  throwIfAborted(abortSignal);
  assertPipelineBreakerClosed("music");
  const apiKey = getMusicApiKey();
  assertLyricsGate({ lyrics: options.lyrics, isInstrumental: options.isInstrumental });
  reportPipelineProgress("lyrics", PIPELINE_PROGRESS.lyrics, onProgress);
  const request = buildSonicCreatePayload(options);
  assertBaseAudioContractInput(request);
  logPreConditionPassed("music", "Sonic payload valid");
  logPipelineStep("music");
  reportPipelineProgress("sonic", PIPELINE_PROGRESS.sonic, onProgress);

  try {
    const { response, raw } = await postSonicCreate(request, apiKey, abortSignal);

    throwIfAborted(abortSignal);
    recordPipelineHttp("music", response.status);
    if (!response.ok) {
      const detail =
        raw && typeof raw === "object" && "error" in raw
          ? String((raw as { error?: unknown }).error)
          : `Request failed (${response.status})`;
      logPipelineStepError("music", new Error(detail), {
        status: response.status,
        body: previewBody(raw),
      });
      throw new Error(`Music engine: ${detail}`);
    }

    const taskId = readTaskId(raw);
    if (!taskId) {
      throw new StudioPipelineError("GATE_2", "Base audio URL was not returned");
    }

    logPostConditionPassed("Sonic task accepted");
    return { taskId, payload: request, status: "processing" };
  } catch (error) {
    if (isGenerationAborted(error)) throw error;
    recordPipelineFailure("music", error);
    logFailedStudioGate(error);
    if (!isFailEarlyGuardError(error) && !isPipelineBreakerOpenError(error)) {
      logPipelineStepError("music", error);
    }
    throw error;
  }
}

export class TransientSonicPollError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TransientSonicPollError";
    this.status = status;
  }
}

export function isTransientSonicPollError(error: unknown): error is TransientSonicPollError {
  return error instanceof TransientSonicPollError;
}

function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function fetchStudioTrackTask(
  taskId: string,
  abortSignal?: AbortSignal,
): Promise<StudioTrackResult> {
  throwIfAborted(abortSignal);
  const apiKey = getMusicApiKey();
  const pollEndpoints = [
    `${SONIC_PRIMARY_TASK_URL}/${encodeURIComponent(taskId)}`,
    `${SONIC_FALLBACK_TASK_URL}/${encodeURIComponent(taskId)}`,
  ];
  let response: Response | null = null;
  let raw: unknown = null;
  let lastError: unknown = null;

  for (const targetUrl of pollEndpoints) {
    logAimusicRequest(targetUrl, apiKey);
    try {
      response = await fetch(targetUrl, {
        method: "GET",
        headers: musicApiAuthHeaders(apiKey),
        signal: mergeAbortSignals(AIMUSICAPI_FETCH_TIMEOUT_MS, abortSignal),
      });
      console.log("[MUSICAPI_DISPATCH]", { url: targetUrl, status: response.status });
      raw = await readResponseBody(response);
      console.log("[MUSICAPI_POLL_RESPONSE]", response.status, previewBody(raw));

      if (
        !response.ok &&
        targetUrl.startsWith(SONIC_PRIMARY_TASK_URL) &&
        (response.status === 404 || response.status === 502 || response.status === 503)
      ) {
        console.warn("[MUSICAPI_DISPATCH] primary poll host failed — trying MusicAPI fallback");
        lastError = new Error(`Primary MusicAPI poll failed (${response.status})`);
        continue;
      }
      break;
    } catch (error) {
      if (isGenerationAborted(error)) throw error;
      lastError = error;
      if (targetUrl.startsWith(SONIC_PRIMARY_TASK_URL)) {
        console.warn(
          "[MUSICAPI_DISPATCH] primary poll host unreachable — trying MusicAPI fallback",
          error instanceof Error ? error.message : error,
        );
        continue;
      }
      throw new TransientSonicPollError(
        error instanceof Error ? error.message : "Network error while polling Sonic task",
      );
    }
  }

  if (!response) {
    throw lastError instanceof Error
      ? new TransientSonicPollError(lastError.message)
      : new TransientSonicPollError("Network error while polling Sonic task");
  }
  if (response.status === 202) {
    return {
      taskId,
      status: "processing",
      audioUrl: null,
      imageUrl: null,
      title: null,
      duration: null,
      trackIds: [taskId],
      rawStatus: "processing",
      clipCount: dataRecords(raw).length,
    };
  }
  if (!response.ok) {
    console.error("[AIMUSICAPI_ERROR]", response.status, previewBody(raw));
    if (isTransientHttpStatus(response.status)) {
      throw new TransientSonicPollError(
        `Transient poll failure (${response.status})`,
        response.status,
      );
    }
    recordPipelineHttp("music", response.status);
    throw new Error(`Music engine: task poll failed (${response.status})`);
  }
  const clip = readTaskResult(raw);
  if (TERMINAL_SUCCESS_STATUSES.includes(clip.rawStatus)) {
    console.log("[GATE_2_RAW_POLL_RESULT]", JSON.stringify(raw, null, 2));
    if (!clip.audioUrl) {
      console.error("[GATE_2_PARSE_FAIL] Could not locate audio URL in:", raw);
    }
  }
  return {
    taskId,
    status: clip.status,
    audioUrl: clip.audioUrl,
    imageUrl: clip.imageUrl,
    title: clip.title,
    duration: clip.duration,
    trackIds: readTrackIds(raw, taskId),
    rawStatus: clip.rawStatus,
    clipCount: dataRecords(raw).length,
  };
}

/**
 * Poll every 3s. The ceiling stays at 5 minutes because observed Sonic renders
 * finish around 240s — a 180s cap would fail tracks that are still rendering.
 */
export const POLLING_INTERVAL_MS = 3000;
export const MAX_POLLING_DURATION_MS = 300000; // 5 minutes max
export const MAX_CONSECUTIVE_NETWORK_ERRORS = 3;

const INTERMEDIATE_STATUSES = new Set([
  "pending",
  "processing",
  "queued",
  "running",
  "unknown",
]);

function renderProgressPercent(startedAt: number, now: number): number {
  const elapsed = Math.max(0, now - startedAt);
  const span = Math.max(1, MAX_POLLING_DURATION_MS);
  const from = PIPELINE_PROGRESS.sonic;
  const to = 90;
  return Math.min(to, Math.round(from + (elapsed / span) * (to - from)));
}

/**
 * Music → stems gate: audioUrl must be a non-null http(s) URL before Demucs.
 * Logs the handoff payload used by the stem / master stages.
 */
export function assertHandoffToStems(result: {
  audioUrl: string | null | undefined;
  taskId: string;
  trackIds?: string[];
}): string {
  const audioUrl = typeof result.audioUrl === "string" ? result.audioUrl.trim() : "";
  if (!audioUrl || !isHttpAudioUrl(audioUrl)) {
    throw new StudioPipelineError("GATE_2", "Base audio URL was not returned");
  }
  console.log("[PIPELINE:HANDOFF_TO_STEMS]", {
    audioUrl,
    taskId: result.taskId,
    ...(result.trackIds?.length ? { trackIds: result.trackIds } : {}),
  });
  return audioUrl;
}

export async function waitForStudioTrack(
  taskId: string,
  hooks: StudioTrackHooks = {},
): Promise<StudioTrackResult> {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_POLLING_DURATION_MS;
  let consecutiveNetworkErrors = 0;
  reportPipelineProgress("sonic", PIPELINE_PROGRESS.sonic, hooks.onProgress);

  while (Date.now() < deadline) {
    throwIfAborted(hooks.abortSignal);
    try {
      const current = await fetchStudioTrackTask(taskId, hooks.abortSignal);
      consecutiveNetworkErrors = 0;
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      const statusLabel = current.rawStatus || current.status;
      console.log(
        `[GATE_1_POLL_TICK] elapsed: ${elapsedSeconds}s, status:`,
        statusLabel,
        "clips:",
        current.clipCount,
      );

      if (current.status === "failed") {
        console.log(
          `[SONIC_V5_POLL] Task: ${taskId} | Status: ${statusLabel} | Elapsed: ${elapsedSeconds}s`,
        );
        throw new Error("Music engine: generation failed.");
      }

      if (current.status === "completed" && isHttpAudioUrl(current.audioUrl)) {
        const reachable = await probeAudioUrlReachable(current.audioUrl);
        if (reachable) {
          logGateCleared(2, `Audio URL verified: ${current.audioUrl}`);
          const output = assertBaseAudioContractOutput({
            audioUrl: current.audioUrl,
            duration: current.duration,
          });
          recordPipelineSuccess("music");
          logPostConditionPassed("Base audio ready for Stem Separation");
          reportPipelineProgress("sonic", 90, hooks.onProgress);
          console.log(
            `[SONIC_V5_POLL] Task: ${taskId} | Status: ${statusLabel} | Elapsed: ${elapsedSeconds}s`,
          );
          const audioUrl = assertHandoffToStems({
            audioUrl: output.audioUrl,
            taskId,
            trackIds: current.trackIds,
          });
          return {
            ...current,
            audioUrl,
            duration: output.duration,
            title: current.title,
            trackIds: current.trackIds.length ? current.trackIds : [taskId],
          };
        }
        console.warn(
          `[SONIC_V5_POLL] Task: ${taskId} | audio_url not reachable yet — continuing`,
        );
      }

      if (INTERMEDIATE_STATUSES.has(statusLabel) || current.status === "processing") {
        console.log(
          `[SONIC_V5_POLL] Task: ${taskId} | Status: ${statusLabel} | Elapsed: ${elapsedSeconds}s`,
        );
        reportPipelineProgress(
          "sonic",
          renderProgressPercent(startedAt, Date.now()),
          hooks.onProgress,
        );
      } else {
        console.log(
          `[SONIC_V5_POLL] Task: ${taskId} | Status: ${statusLabel} | Elapsed: ${elapsedSeconds}s`,
        );
      }
    } catch (error) {
      if (isGenerationAborted(error)) throw error;
      if (error instanceof StudioPipelineError) throw error;
      if (isTransientSonicPollError(error)) {
        consecutiveNetworkErrors += 1;
        const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
        console.warn(
          `[SONIC_V5_POLL] Transient error (${consecutiveNetworkErrors}/${MAX_CONSECUTIVE_NETWORK_ERRORS})`,
          `Task: ${taskId} | Elapsed: ${elapsedSeconds}s |`,
          error.message,
          error.status ?? "",
        );
        if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
          recordPipelineFailure("music", error);
          throw new Error(
            `Music engine: task poll failed after ${MAX_CONSECUTIVE_NETWORK_ERRORS} network errors.`,
          );
        }
      } else if (
        error instanceof Error &&
        error.message === "Music engine: generation failed."
      ) {
        throw error;
      } else if (error instanceof Error && /Music engine:/i.test(error.message)) {
        throw error;
      } else if (!(error instanceof TransientSonicPollError)) {
        // Permanent poll parse / contract errors bubble; unknown keep looping only for transient.
        throw error;
      }
    }
    await abortableDelay(POLLING_INTERVAL_MS, hooks.abortSignal);
  }
  throw new StudioPipelineError("GATE_2", "Base audio URL was not returned");
}

/** Full Stage 2 contract: Sonic create → poll → verified URL + duration. */
export async function fulfillBaseAudioContract(
  options: StudioTrackOptions,
  hooks: StudioTrackHooks = {},
): Promise<BaseAudioContract["output"]> {
  const started = await generateStudioTrack(options, hooks);
  const finished = await waitForStudioTrack(started.taskId, hooks);
  return assertBaseAudioContractOutput({
    audioUrl: finished.audioUrl,
    duration: finished.duration,
  });
}
