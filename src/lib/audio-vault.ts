/** Dedicated bucket for vault masters (dashboard: Storage → audio-vault). */
export const AUDIO_VAULT_BUCKET = "audio-vault";

/** Studio engine archive bucket (stems and fallback masters). */
export const STUDIO_AUDIO_BUCKET = "studio-deliveries";

/** 150 MB — matches the bucket file_size_limit. */
export const AUDIO_VAULT_MAX_BYTES = 157_286_400;

export const AUDIO_VAULT_MIME_TYPES = [
  "audio/wav",
  "audio/x-wav",
  "audio/mpeg",
  "audio/mp3",
  "audio/flac",
] as const;

export type VaultAudioFileType = "wav" | "mp3" | "flac";

const STORAGE_BUCKETS = [STUDIO_AUDIO_BUCKET, AUDIO_VAULT_BUCKET] as const;

export type StoredAudioObject = { bucket: string; path: string };

/** Extracts bucket + object path from a Supabase signed/public URL. */
export function storageObjectFromUrl(url: string): StoredAudioObject | null {
  try {
    const parsed = new URL(url);
    for (const bucket of STORAGE_BUCKETS) {
      const marker = `/${bucket}/`;
      const index = parsed.pathname.indexOf(marker);
      if (index === -1) continue;
      const path = decodeURIComponent(parsed.pathname.slice(index + marker.length));
      if (path) return { bucket, path };
    }
    return null;
  } catch {
    return null;
  }
}

export function storagePathFromUrl(url: string): string | null {
  return storageObjectFromUrl(url)?.path ?? null;
}

export function normalizeVaultFileType(fileType: string): VaultAudioFileType {
  const ext = fileType.replace(/^\./, "").toLowerCase();
  if (ext === "wav") return "wav";
  if (ext === "flac") return "flac";
  return "mp3";
}

/** `audio/wav` for WAV, `audio/flac` for FLAC, `audio/mpeg` for MP3. */
export function vaultMimeType(fileType: string): string {
  const ext = normalizeVaultFileType(fileType);
  if (ext === "wav") return "audio/wav";
  if (ext === "flac") return "audio/flac";
  return "audio/mpeg";
}

/** `masters/{track_id}_master.{wav|mp3|flac}` — same layout as the vault upload handler. */
export function vaultMasterObjectPath(trackId: string, fileType: string = "wav"): string {
  const id = trackId.replace(/[^a-zA-Z0-9_-]/g, "_") || "track";
  return `masters/${id}_master.${normalizeVaultFileType(fileType)}`;
}

export function vaultStemObjectPath(
  trackId: string,
  stem: "master" | "vocal" | "instrumental",
  fileType: string = "mp3",
): string {
  const id = trackId.replace(/[^a-zA-Z0-9_-]/g, "_") || "track";
  return `masters/${id}_${stem}.${normalizeVaultFileType(fileType)}`;
}
