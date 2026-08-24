import type { Division } from "@/lib/divisions";
import type { Album, StreamTrack } from "@/lib/radio-tracks";
import type { RadioTrack } from "@/components/RadioPlayer";

/** Row shape written by `scripts/sync-artist-catalog.ts`. */
export type ArtistCatalogTrack = {
  id: string;
  album_id: string;
  album_title: string;
  artist_name: string;
  title: string;
  track_number: number;
  track_total: number | null;
  audio_url: string;
  cover_url: string | null;
  storage_path: string;
  genre: string | null;
  credits: string | null;
  division: string | null;
  radio_ready: boolean;
  price_tokens: number;
};

/** Shared playable contract for Artist page, album views, and Radio. */
export type CatalogPlayable = {
  id: string;
  title: string;
  artist: string;
  src: string;
  cover?: string;
  album?: string;
  genre?: string;
  credits?: string;
  trackNumber?: number;
  trackTotal?: number;
  division?: Division;
  priceTokens?: number;
  radioReady?: boolean;
};

export function isPlayableCatalogUrl(url: string | null | undefined): boolean {
  if (!url || typeof url !== "string") return false;
  const v = url.trim();
  if (!v) return false;
  if (/^https?:\/\//i.test(v)) return true;
  if (v.startsWith("/")) return true;
  return false;
}

/** Parse `01-Title.mp3`, `01. Title.wav`, or bare `Title.mp3`. */
export function parseTrackFilename(filename: string): {
  trackNumber: number | null;
  title: string;
} {
  const base = filename.replace(/\.(mp3|wav|flac|m4a)$/i, "").trim();
  const numbered = base.match(/^(\d{1,3})\s*[-.)_]\s*(.+)$/);
  if (numbered) {
    return {
      trackNumber: Number.parseInt(numbered[1], 10),
      title: numbered[2].replace(/[_]+/g, " ").replace(/\s+/g, " ").trim(),
    };
  }
  return {
    trackNumber: null,
    title: base
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\(\d+\)$/g, "")
      .trim(),
  };
}

function asDivision(raw: string | null | undefined): Division | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "usa" || v === "nigeria" || v === "lithuania" || v === "jester") {
    return v;
  }
  return undefined;
}

/** Map a synced artist_tracks row into the global playable shape (`src` = CDN). */
export function artistTrackToPlayable(row: ArtistCatalogTrack): CatalogPlayable | null {
  if (!row?.id || !row.title || !isPlayableCatalogUrl(row.audio_url)) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist_name || "Hybrid AI Records",
    src: row.audio_url.trim(),
    cover: row.cover_url?.trim() || undefined,
    album: row.album_title,
    genre: row.genre ?? undefined,
    credits: row.credits ?? undefined,
    trackNumber: row.track_number,
    trackTotal: row.track_total ?? undefined,
    division: asDivision(row.division),
    priceTokens: row.price_tokens || 1,
    radioReady: row.radio_ready,
  };
}

export function playableToStreamTrack(track: CatalogPlayable): StreamTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    src: track.src,
    cover: track.cover,
    album: track.album,
    genre: track.genre,
    credits: track.credits,
    trackNumber: track.trackNumber,
    trackTotal: track.trackTotal,
    division: track.division,
    priceTokens: track.priceTokens ?? 1,
  };
}

export function playableToRadioTrack(track: CatalogPlayable): RadioTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    src: track.src,
    cover: track.cover,
    album: track.album,
    genre: track.genre,
    credits: track.credits,
    trackNumber: track.trackNumber,
    trackTotal: track.trackTotal,
    division: track.division,
  };
}

export function groupPlayablesAsAlbums(tracks: CatalogPlayable[]): Album[] {
  const byAlbum = new Map<string, CatalogPlayable[]>();
  for (const track of tracks) {
    const key = track.album || "Singles";
    const list = byAlbum.get(key) ?? [];
    list.push(track);
    byAlbum.set(key, list);
  }
  return Array.from(byAlbum.entries()).map(([title, list]) => {
    const sorted = [...list].sort(
      (a, b) => (a.trackNumber ?? 0) - (b.trackNumber ?? 0) || a.title.localeCompare(b.title),
    );
    const head = sorted[0];
    return {
      id: head?.album ? slugish(head.album) : slugish(title),
      title,
      artist: head?.artist ?? "Hybrid AI Records",
      cover: head?.cover ?? "",
      credits: head?.credits ?? "",
      genre: head?.genre ?? "",
      division: head?.division,
      tracks: sorted.map((t) => ({ id: t.id, title: t.title, src: t.src })),
    };
  });
}

function slugish(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Prefer catalog CDN `src` when ids/titles match static radio tracks so Artist
 * page, album views, and Radio all hit the same public URL.
 */
export function mergeCatalogIntoStreamTracks(
  base: StreamTrack[],
  catalog: CatalogPlayable[],
): StreamTrack[] {
  if (!catalog.length) return base;
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const byTitle = new Map(
    catalog.map((t) => [`${(t.album ?? "").toLowerCase()}::${t.title.toLowerCase()}`, t]),
  );

  const merged = base.map((track) => {
    const hit =
      byId.get(track.id) ||
      byTitle.get(`${(track.album ?? "").toLowerCase()}::${track.title.toLowerCase()}`);
    if (!hit?.src) return track;
    return {
      ...track,
      src: hit.src,
      cover: hit.cover ?? track.cover,
      trackNumber: hit.trackNumber ?? track.trackNumber,
      trackTotal: hit.trackTotal ?? track.trackTotal,
    };
  });

  const seen = new Set(merged.map((t) => t.id));
  for (const track of catalog) {
    if (seen.has(track.id)) continue;
    if (track.radioReady === false) continue;
    merged.push(playableToStreamTrack(track));
    seen.add(track.id);
  }
  return merged;
}

export function radioReadyOnly(tracks: CatalogPlayable[]): CatalogPlayable[] {
  return tracks.filter((t) => t.radioReady !== false && isPlayableCatalogUrl(t.src));
}
