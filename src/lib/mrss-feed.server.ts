import { tryGetSupabaseAdmin } from "@/integrations/supabase/client.server";
import { buildMRSSFeed } from "../../hybrid-syndication-engine/src/layer3-feeds/mrss-builder";
import type { TrackPayload } from "../../hybrid-syndication-engine/src/types";
import { portalBaseUrl } from "../../hybrid-syndication-engine/src/urls";

const ARTIST_TRACK_COLUMNS =
  "id, title, artist_name, album_title, genre, audio_url, cover_url, created_at";

type ArtistTrackRow = {
  id: string;
  title: string | null;
  artist_name: string | null;
  album_title: string | null;
  genre: string | null;
  audio_url: string | null;
  cover_url: string | null;
  created_at: string | null;
};

function absoluteAssetUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return `${portalBaseUrl()}${trimmed}`;
  return trimmed;
}

function releaseDate(value: string | null): string {
  if (!value) return "1970-01-01";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "1970-01-01";
  return parsed.toISOString().slice(0, 10);
}

export function artistTracksToPayloads(rows: ArtistTrackRow[]): TrackPayload[] {
  const payloads: TrackPayload[] = [];
  for (const row of rows) {
    const title = row.title?.trim() ?? "";
    const audioUrl = absoluteAssetUrl(row.audio_url);
    if (!row.id || !title || !audioUrl) continue;
    payloads.push({
      id: row.id,
      title,
      artistName: row.artist_name?.trim() || "Hybrid AI Records",
      albumName: row.album_title?.trim() || title,
      genre: row.genre?.trim() || "",
      releaseDate: releaseDate(row.created_at),
      durationSeconds: 0,
      previewAudioUrl: audioUrl,
      masterAudioUrl: audioUrl,
      coverArtUrl: absoluteAssetUrl(row.cover_url),
      explicit: false,
      tokenPriceUsd: 2,
    });
  }
  return payloads;
}

/** Live catalog MRSS, or a valid empty channel when Supabase is unavailable. */
export async function renderCatalogMrss(): Promise<string> {
  try {
    const admin = tryGetSupabaseAdmin();
    if (!admin) {
      console.warn("[mrss] Supabase admin env missing; serving an empty channel.");
      return buildMRSSFeed([]);
    }

    const { data, error } = await admin
      .from("artist_tracks")
      .select(ARTIST_TRACK_COLUMNS)
      .order("album_title", { ascending: true })
      .order("track_number", { ascending: true });

    if (error) {
      console.warn("[mrss] artist_tracks query failed; serving an empty channel.", error.message);
      return buildMRSSFeed([]);
    }

    return buildMRSSFeed(artistTracksToPayloads((data ?? []) as ArtistTrackRow[]));
  } catch (error) {
    const message = error instanceof Error ? error.message : "catalog load failed";
    console.warn("[mrss] Catalog load failed; serving an empty channel.", message);
    return buildMRSSFeed([]);
  }
}
