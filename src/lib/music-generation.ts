/**
 * Suno / Sonic 5.5 studio generation (MusicAPI).
 *
 * Lyrics belong on `prompt`. Style metadata belongs on `tags`.
 * This module is server-only — it reads MUSIC_API_KEY.
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

function musicApiKey(): string {
  const key = process.env.MUSIC_API_KEY?.trim();
  if (!key) {
    throw new Error("MUSIC_API_KEY is not configured.");
  }
  return key;
}

function sonicHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${musicApiKey()}`,
  };
}

function readTaskId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const nested =
    row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : null;
  const id = row.task_id ?? row.taskId ?? nested?.task_id ?? nested?.id;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

function readClip(body: unknown): {
  audioUrl: string | null;
  imageUrl: string | null;
  title: string | null;
  status: string;
} {
  if (!body || typeof body !== "object") {
    return { audioUrl: null, imageUrl: null, title: null, status: "processing" };
  }
  const row = body as Record<string, unknown>;
  const status = String(row.status ?? row.state ?? "processing").toLowerCase();
  const clips = Array.isArray(row.data)
    ? row.data
    : Array.isArray(row.clips)
      ? row.clips
      : row.data && typeof row.data === "object"
        ? [row.data]
        : [];
  for (const clip of clips) {
    if (!clip || typeof clip !== "object") continue;
    const item = clip as Record<string, unknown>;
    const audioUrl =
      (typeof item.audio_url === "string" && item.audio_url) ||
      (typeof item.audioUrl === "string" && item.audioUrl) ||
      null;
    if (audioUrl) {
      return {
        audioUrl,
        imageUrl: typeof item.image_url === "string" ? item.image_url : null,
        title: typeof item.title === "string" ? item.title : null,
        status: "completed",
      };
    }
  }
  if (status.includes("fail") || status.includes("error")) {
    return { audioUrl: null, imageUrl: null, title: null, status: "failed" };
  }
  return { audioUrl: null, imageUrl: null, title: null, status: "processing" };
}

export async function generateStudioTrack(options: StudioTrackOptions): Promise<StudioTrackStart> {
  if (!process.env.MUSIC_API_KEY?.trim()) {
    throw new Error("MUSIC_API_KEY is not configured.");
  }

  const payload = {
    custom_mode: true,
    mv: "sonic-v5-5", // Explicit Suno 5.5 model flag
    prompt: options.lyrics,
    tags: [
      options.genre,
      options.subGenre,
      options.bpm ? `${options.bpm} BPM` : null,
      options.instruments?.length ? options.instruments.join(", ") : null,
      options.vocalTimbre || "raw acoustic studio recording",
    ]
      .filter(Boolean)
      .join(", "),
    title: options.title || "Hybrid Master",
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
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.MUSIC_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const raw: unknown = await response.json().catch(() => null);
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
  const response = await fetch(`${SONIC_TASK_URL}/${encodeURIComponent(taskId)}`, {
    method: "GET",
    headers: sonicHeaders(),
  });
  const raw: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Suno 5.5: task poll failed (${response.status})`);
  }
  const clip = readClip(raw);
  return {
    taskId,
    status: clip.status === "completed" ? "completed" : clip.status === "failed" ? "failed" : "processing",
    audioUrl: clip.audioUrl,
    imageUrl: clip.imageUrl,
    title: clip.title,
  };
}

const POLL_MS = 3_000;
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
