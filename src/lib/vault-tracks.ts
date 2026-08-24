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
  /** Raw Gate 1 engine audio, before stems and mastering. */
  raw_audio_url: string | null;
  created_at: string;
  /** Resolved from artists(*) join or denormalized artist_name. */
  artist_name: string;
  /** Resolved from albums(*) join or denormalized album_name. */
  album_name: string;
};

export type VaultAlbumGroup = {
  artist_name: string;
  album_name: string;
  tracks: SanitizedVaultTrack[];
};

export type VaultArtistGroup = {
  artist_name: string;
  albums: VaultAlbumGroup[];
};

const DEFAULT_ARTIST = "Unknown Artist";
const DEFAULT_ALBUM = "Singles";

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

function relationName(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function resolveArtistName(row: Record<string, unknown>): string {
  const fromJoin = relationName(row.artist);
  if (fromJoin) return fromJoin;
  if (typeof row.artist_name === "string" && row.artist_name.trim()) return row.artist_name.trim();
  if (typeof row.artistName === "string" && row.artistName.trim()) return row.artistName.trim();
  return DEFAULT_ARTIST;
}

function resolveAlbumName(row: Record<string, unknown>): string {
  const fromJoin = relationName(row.album);
  if (fromJoin) return fromJoin;
  if (typeof row.album_name === "string" && row.album_name.trim()) return row.album_name.trim();
  if (typeof row.albumName === "string" && row.albumName.trim()) return row.albumName.trim();
  return DEFAULT_ALBUM;
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
    const rawAudioUrl = playableOrNull(row.raw_audio_url ?? row.rawAudioUrl);
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
      raw_audio_url: nextStatus === "completed" ? rawAudioUrl : null,
      created_at: createdAt,
      artist_name: resolveArtistName(row),
      album_name: resolveAlbumName(row),
    });
  }
  return out;
}

/**
 * Groups vault tracks by artist_name → album_name (stable alphabetical order).
 * Tracks within an album stay newest-first when created_at is present.
 */
export function groupVaultTracksByArtistAlbum(
  tracks: readonly SanitizedVaultTrack[],
): VaultArtistGroup[] {
  const byArtist = new Map<string, Map<string, SanitizedVaultTrack[]>>();

  for (const track of tracks) {
    const artist = track.artist_name.trim() || DEFAULT_ARTIST;
    const album = track.album_name.trim() || DEFAULT_ALBUM;
    let albums = byArtist.get(artist);
    if (!albums) {
      albums = new Map();
      byArtist.set(artist, albums);
    }
    const list = albums.get(album) ?? [];
    list.push(track);
    albums.set(album, list);
  }

  const artists = [...byArtist.keys()].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );

  return artists.map((artist_name) => {
    const albumMap = byArtist.get(artist_name)!;
    const albumNames = [...albumMap.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    return {
      artist_name,
      albums: albumNames.map((album_name) => {
        const albumTracks = [...(albumMap.get(album_name) ?? [])].sort(
          (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
        );
        return { artist_name, album_name, tracks: albumTracks };
      }),
    };
  });
}

export { DEFAULT_ALBUM as VAULT_DEFAULT_ALBUM, DEFAULT_ARTIST as VAULT_DEFAULT_ARTIST };
