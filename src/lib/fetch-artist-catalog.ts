import { supabase } from "@/integrations/supabase/client";
import {
  artistTrackToPlayable,
  radioReadyOnly,
  type ArtistCatalogTrack,
  type CatalogPlayable,
} from "@/lib/artist-catalog";

const SELECT =
  "id, album_id, album_title, artist_name, title, track_number, track_total, audio_url, cover_url, storage_path, genre, credits, division, radio_ready, price_tokens";

function mapRows(data: ArtistCatalogTrack[] | null | undefined): CatalogPlayable[] {
  return (data ?? [])
    .map(artistTrackToPlayable)
    .filter((t): t is CatalogPlayable => Boolean(t));
}

/** Browser catalog load (public RLS). Named without `.client.` so SSR routes can import it. */
export async function fetchArtistCatalogTracks(): Promise<CatalogPlayable[]> {
  const { data, error } = await supabase
    .from("artist_tracks")
    .select(SELECT)
    .order("album_title", { ascending: true })
    .order("track_number", { ascending: true });

  if (error) {
    console.error("[artist_tracks] fetch failed:", error.message);
    return [];
  }

  const tracks = mapRows(data as ArtistCatalogTrack[] | null);
  console.log(
    "[artist_tracks] fetched on mount:",
    tracks.length,
    tracks.map((t) => ({
      id: t.id,
      title: t.title,
      album: t.album,
      cover_url: t.cover,
      audio_url: t.audio_url ?? t.src,
    })),
  );
  return tracks;
}

/** Radio station source: radio_ready rows with a public CDN audio URL. */
export async function fetchRadioReadyTracks(): Promise<CatalogPlayable[]> {
  const { data, error } = await supabase
    .from("artist_tracks")
    .select(SELECT)
    .eq("radio_ready", true)
    .order("album_title", { ascending: true })
    .order("track_number", { ascending: true });

  if (error) {
    console.error("[artist_tracks] radio_ready fetch failed:", error.message);
    return [];
  }

  const tracks = radioReadyOnly(mapRows(data as ArtistCatalogTrack[] | null));
  console.log(
    "[radio] station queue init from artist_tracks:",
    tracks.length,
    tracks.map((t) => ({
      id: t.id,
      title: t.title,
      cover_url: t.cover,
      audio_url: t.audio_url ?? t.src,
    })),
  );
  return tracks;
}
