/**
 * Client-side upload gate. Runs entirely in the browser BEFORE any orchestration
 * or render dispatch, so a wrong file never burns compute credits upstream.
 */

export const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50 MB — client-side guard before any backend call
export const MIN_AUDIO_BYTES = 16 * 1024; // 16 KB — anything smaller is not a real track

/** Audio formats accepted for the cinematic pipeline. */
export const ACCEPTED_AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".flac"] as const;
export const ACCEPTED_AUDIO_MIME = [
  "audio/*",
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/vnd.wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/flac",
  "audio/x-flac",
] as const;

/** `accept` attribute for file inputs, kept in sync with the validator. */
export const AUDIO_ACCEPT_ATTR = "audio/*,audio/mp3,audio/wav,audio/m4a,audio/flac";

export type AudioValidation = { ok: true } | { ok: false; error: string };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function validateAudioUpload(file: File | null | undefined): AudioValidation {
  if (!file) return { ok: false, error: "No file selected." };

  const name = file.name.toLowerCase();
  const extOk = ACCEPTED_AUDIO_EXTENSIONS.some((ext) => name.endsWith(ext));
  const mime = (file.type || "").toLowerCase();
  // Some browsers report an empty type for dragged files — extension is authoritative.
  const mimeOk =
    mime === "" ||
    mime.startsWith("audio/") ||
    (ACCEPTED_AUDIO_MIME as readonly string[]).includes(mime);

  if (!extOk || !mimeOk) {
    return {
      ok: false,
      error: "Unsupported format — upload an MP3, WAV, M4A or FLAC audio file.",
    };
  }

  if (file.size < MIN_AUDIO_BYTES) {
    return { ok: false, error: "That file looks empty or corrupted — upload a full track." };
  }

  if (file.size > MAX_AUDIO_BYTES) {
    return {
      ok: false,
      error: `Track is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_AUDIO_BYTES)}. Export a smaller audio file.`,
    };
  }

  return { ok: true };
}

