/**
 * Shared vault-catalog sanitizing. Used by the Engine vault UI and the
 * /api/studio/vault list so a corrupt or half-written row can never reach
 * the <audio> player.
 */

export type VaultTrackStatus = "processing" | "completed" | "failed";

export type SanitizedVaultTrack = {
  id: string;
  title: string;
  style: string;
  status: VaultTrackStatus;
  master_url: string | null;
  instrumental_url: string | null;
  vocal_url: string | null;
  created_at: string;
};

export function asVaultTrackStatus(value: unknown): VaultTrackStatus {
  if (value === "completed" || value === "failed" || value === "processing") return value;
  return "processing";
}

/** True when a browser <audio> element can reasonably stream this URL. */
export function isPlayableVaultAudioUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed === "null" || trimmed === "undefined") return false;
  if (/^(https?:\/\/|blob:|data:audio\/)/i.test(trimmed)) return true;
  // Local vault / temp master fallbacks are same-origin paths.
  return trimmed.startsWith("/");
}

function playableOrNull(url: unknown): string | null {
  if (!isPlayableVaultAudioUrl(url)) return null;
  return url.trim();
}

/**
 * Drops corrupt rows and strips unusable audio URLs.
 * Processing / null-audio rows stay in the catalog for status, but never carry
 * a source the player could try to load.
 */
export function sanitizeVaultTracks(input: unknown): SanitizedVaultTrack[] {
  if (!Array.isArray(input)) return [];
  const out: SanitizedVaultTrack[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id) continue;

    const status = asVaultTrackStatus(row.status);
    const masterUrl = playableOrNull(row.master_url ?? row.masterUrl ?? row.audio_url ?? row.audioUrl);
    const instrumentalUrl = playableOrNull(row.instrumental_url ?? row.instrumentalUrl);
    const vocalUrl = playableOrNull(row.vocal_url ?? row.vocalUrl);
    const createdAt =
      typeof row.created_at === "string" && row.created_at
        ? row.created_at
        : typeof row.createdAt === "string" && row.createdAt
          ? row.createdAt
          : new Date(0).toISOString();

    // A playable master always wins over a stale processing/failed flag so the
    // vault never hides a finished render or paints a phantom failure.
    const nextStatus: VaultTrackStatus = masterUrl
      ? "completed"
      : status === "completed"
        ? "failed"
        : status;

    out.push({
      id,
      title: typeof row.title === "string" && row.title.trim() ? row.title.trim() : "Untitled Track",
      style: typeof row.style === "string" && row.style.trim() ? row.style.trim() : "Custom",
      status: nextStatus,
      master_url: nextStatus === "completed" ? masterUrl : null,
      instrumental_url: nextStatus === "completed" ? instrumentalUrl : null,
      vocal_url: nextStatus === "completed" ? vocalUrl : null,
      created_at: createdAt,
    });
  }
  return out;
}
