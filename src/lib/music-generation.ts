/**
 * Suno / Sonic 5.5 studio generation (MusicAPI).
 *
 * Two-step workflow: POST /sonic/create, then poll GET /sonic/task/{id}
 * until `data.status` is succeeded or failed.
 *
 * Server-only: imported from `generateEngineTrack` (`createServerFn` handler).
 * Reads Node `process.env`; never import this from client components.
 */

export const SONIC_CREATE_URL = "https://api.musicapi.ai/api/v1/sonic/create";
export const SONIC_TASK_URL = "https://api.musicapi.ai/api/v1/sonic/task";
export const SONIC_MODEL = "sonic-v5-5";

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
  mv: typeof SONIC_MODEL;
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

export function musicApiKey(): string {
  const apiKey =
    process.env.MUSIC_API_KEY || process.env.MUSICAPI_KEY || process.env.SONIC_API_KEY;
  const trimmed = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!trimmed) {
    console.error("[ENV_ERROR] Music API key not found in process.env");
    throw new Error("Music API key is not configured");
  }
  return trimmed;
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

export async function generateStudioTrack(options: StudioTrackOptions): Promise<StudioTrackStart> {
  const apiKey = musicApiKey();

  const payload: SonicCreatePayload = {
    task_type: "create_music",
    custom_mode: true,
    mv: SONIC_MODEL,
    prompt: options.lyrics ?? "",
    tags: styleTags(options) || options.genre || "",
    title: options.title || "Studio Master",
    make_instrumental: Boolean(options.isInstrumental),
    vocal_gender: options.vocalGender?.toLowerCase().startsWith("f") ? "f" : "m",
    negative_tags: options.vocalGender?.toLowerCase().startsWith("f")
      ? "male vocals, low baritone, synthpop, electronic dance"
      : "female vocals, soprano, synthpop, 80s dance pop, electronic synths, autotune",
  };

  console.log("[SUNO_5_5_DISPATCH_BODY]", JSON.stringify(payload, null, 2));

  const response = await fetch(SONIC_CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const raw: unknown = await response.json().catch(() => null);
  console.log("[MUSICAPI_CREATE_RESPONSE]", JSON.stringify(raw, null, 2));
  if (!response.ok) {
    const detail =
      raw && typeof raw === "object" && "error" in raw
        ? String((raw as { error?: unknown }).error)
        : `Request failed (${response.status})`;
    throw new Error(`Suno 5.5: ${detail}`);
  }

  const taskId = readTaskId(raw);
  if (!taskId) {
    throw new Error("Suno 5.5: the provider returned no task id.");
  }

  return { taskId, payload, status: "processing" };
}

export async function fetchStudioTrackTask(taskId: string): Promise<StudioTrackResult> {
  const apiKey = musicApiKey();
  const response = await fetch(`${SONIC_TASK_URL}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const raw: unknown = await response.json().catch(() => null);
  console.log("[MUSICAPI_POLL_RESPONSE]", JSON.stringify(raw, null, 2));
  if (response.status === 202) {
    return { taskId, status: "processing", audioUrl: null, imageUrl: null, title: null };
  }
  if (!response.ok) {
    throw new Error(`Suno 5.5: task poll failed (${response.status})`);
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
      throw new Error("Suno 5.5: generation failed.");
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error("Suno 5.5: generation timed out.");
}
