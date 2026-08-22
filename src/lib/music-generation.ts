/**
 * Suno / Sonic studio generation (MusicAPI).
 *
 * Two-step workflow: POST /sonic/create, then poll GET /sonic/task/{id}
 * until `data.status` is succeeded or failed.
 *
 * `mv` is MusicAPI's model id. Standard v5 is `sonic-v5`. `sonic-v5-5` is
 * attempted first when requested, then we fall back to `sonic-v5` if the
 * provider rejects it (`mv field is invalid`).
 *
 * Server-only: imported from `generateEngineTrack` (`createServerFn` handler).
 * Reads Node `process.env`; never import this from client components.
 */

import { readEnv, requireStageKey } from "@/lib/env";

export const SONIC_CREATE_URL = "https://api.musicapi.ai/api/v1/sonic/create";
export const SONIC_TASK_URL = "https://api.musicapi.ai/api/v1/sonic/task";
/** Standard MusicAPI v5 model. */
export const SONIC_MODEL = "sonic-v5";
/** Newer id — some accounts reject this; we retry with SONIC_MODEL. */
export const SONIC_MODEL_V55 = "sonic-v5-5";

export type SonicModel = typeof SONIC_MODEL | typeof SONIC_MODEL_V55;

export type StudioTrackOptions = {
  genre?: string;
  subGenre?: string;
  mood?: string;
  bpm?: number | string;
  instruments?: string[];
  vocalTimbre?: string;
  vocalGender?: string;
  lyrics?: string;
  title?: string;
  isInstrumental?: boolean;
};

export type SonicCreatePayload = {
  task_type: "create_music";
  custom_mode: true;
  mv: SonicModel;
  prompt: string;
  tags: string;
  title: string;
  make_instrumental: boolean;
  vocal_gender: "f" | "m";
  negative_tags: string;
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
};

const MUSIC_STAGE = "MusicAPI (Base Arrangement)" as const;

export function getMusicApiKey(): string {
  const apiKey =
    (typeof process !== "undefined" && process.env.AIMUSIC_API_KEY?.trim()) ||
    (typeof process !== "undefined" && process.env.AI_MUSIC_API_KEY?.trim()) ||
    readEnv("AIMUSIC_API_KEY") ||
    readEnv("AI_MUSIC_API_KEY") ||
    readEnv("MUSIC_API_KEY");
  if (!apiKey) {
    console.error(
      "[MUSICAPI] AIMUSIC_API_KEY / AI_MUSIC_API_KEY is undefined — add it to .env.local",
    );
    return requireStageKey("MUSIC_API_KEY", MUSIC_STAGE);
  }
  return apiKey;
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

function firstDataRecord(body: unknown): Record<string, unknown> | null {
  const row = asRecord(body);
  if (!row) return null;
  if (Array.isArray(row.data)) {
    const first = row.data.find((item) => item && typeof item === "object");
    return asRecord(first);
  }
  return asRecord(row.data);
}

function readTaskStatus(body: unknown): string {
  const row = asRecord(body);
  const data = firstDataRecord(body);
  const raw = data?.status ?? data?.state ?? row?.status ?? row?.state ?? "";
  return String(raw).toLowerCase();
}

function readTaskResult(body: unknown): {
  audioUrl: string | null;
  imageUrl: string | null;
  title: string | null;
  status: "completed" | "failed" | "processing";
} {
  const row = asRecord(body);
  if (!row) {
    return { audioUrl: null, imageUrl: null, title: null, status: "processing" };
  }
  const data = firstDataRecord(body);
  const status = readTaskStatus(body);
  const audioUrl = asAudioUrl(
    data?.audio_url ?? data?.audioUrl ?? data?.output ?? row.audio_url ?? row.audioUrl ?? row.output,
  );
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

  if (status === "failed" || status === "fail" || status === "error") {
    return { audioUrl: null, imageUrl, title, status: "failed" };
  }
  if (status === "succeeded" || status === "success" || status === "completed") {
    return {
      audioUrl,
      imageUrl,
      title,
      status: audioUrl ? "completed" : "processing",
    };
  }
  if (audioUrl) {
    return { audioUrl, imageUrl, title, status: "completed" };
  }
  return { audioUrl: null, imageUrl, title, status: "processing" };
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

async function postSonicCreate(
  payload: SonicCreatePayload,
  apiKey: string,
): Promise<{ response: Response; raw: unknown }> {
  console.log("[MUSICAPI_CREATE_REQUEST]", JSON.stringify(payload, null, 2));
  const response = await fetch(SONIC_CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await readResponseBody(response);
  console.log("[MUSICAPI_CREATE_RESPONSE]", response.status, previewBody(raw));
  return { response, raw };
}

export async function generateStudioTrack(options: StudioTrackOptions): Promise<StudioTrackStart> {
  const apiKey = getMusicApiKey();

  const base = {
    task_type: "create_music" as const,
    custom_mode: true as const,
    prompt: options.lyrics ?? "",
    tags: styleTags(options) || options.genre || "",
    title: options.title || "Studio Master",
    make_instrumental: Boolean(options.isInstrumental),
    vocal_gender: options.vocalGender?.toLowerCase().startsWith("f") ? ("f" as const) : ("m" as const),
    negative_tags: options.vocalGender?.toLowerCase().startsWith("f")
      ? "male vocals, low baritone, synthpop, electronic dance"
      : "female vocals, soprano, synthpop, 80s dance pop, electronic synths, autotune",
  };

  // Prefer v5.5 when the account allows it; MusicAPI often returns
  // "mv field is invalid" for sonic-v5-5 — retry standard sonic-v5.
  let payload: SonicCreatePayload = { ...base, mv: SONIC_MODEL_V55 };
  let { response, raw } = await postSonicCreate(payload, apiKey);

  if (!response.ok && isInvalidMvRejection(response.status, raw)) {
    payload = { ...base, mv: SONIC_MODEL };
    console.log(
      "[MUSICAPI_CREATE_FALLBACK]",
      `sonic-v5-5 rejected (${response.status}); retrying ${SONIC_MODEL}`,
    );
    ({ response, raw } = await postSonicCreate(payload, apiKey));
  }

  if (!response.ok) {
    const detail =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as { error?: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(`Music engine: ${detail}`);
  }

  const taskId = readTaskId(raw);
  if (!taskId) {
    throw new Error("Music engine: the provider returned no task id.");
  }

  return { taskId, payload, status: "processing" };
}

export async function fetchStudioTrackTask(taskId: string): Promise<StudioTrackResult> {
  const apiKey = getMusicApiKey();
  const response = await fetch(`${SONIC_TASK_URL}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const raw = await readResponseBody(response);
  console.log("[MUSICAPI_POLL_RESPONSE]", response.status, previewBody(raw));
  if (response.status === 202) {
    return { taskId, status: "processing", audioUrl: null, imageUrl: null, title: null };
  }
  if (!response.ok) {
    throw new Error(`Music engine: task poll failed (${response.status})`);
  }
  const clip = readTaskResult(raw);
  return {
    taskId,
    status: clip.status,
    audioUrl: clip.audioUrl,
    imageUrl: clip.imageUrl,
    title: clip.title,
  };
}

const POLL_MS = 4_000;
const POLL_TIMEOUT_MS = 8 * 60 * 1_000;

export async function waitForStudioTrack(taskId: string): Promise<StudioTrackResult> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await fetchStudioTrackTask(taskId);
    if (current.status === "completed" && current.audioUrl) return current;
    if (current.status === "failed") {
      throw new Error("Music engine: generation failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Music engine: generation timed out.");
}
