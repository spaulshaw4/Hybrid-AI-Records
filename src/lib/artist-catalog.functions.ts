import { createServerFn } from "@tanstack/react-start";
import {
  artistTrackToPlayable,
  radioReadyOnly,
  type ArtistCatalogTrack,
  type CatalogPlayable,
} from "@/lib/artist-catalog";

function mapRows(data: ArtistCatalogTrack[] | null): CatalogPlayable[] {
  return (data ?? [])
    .map(artistTrackToPlayable)
    .filter((t): t is CatalogPlayable => Boolean(t));
}

/** Public catalog for Artist page / album views (all indexed tracks). */
export const listArtistCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogPlayable[]> => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("artist_tracks")
        .select(
          "id, album_id, album_title, artist_name, title, track_number, track_total, audio_url, cover_url, storage_path, genre, credits, division, radio_ready, price_tokens",
        )
        .order("album_title", { ascending: true })
        .order("track_number", { ascending: true });
      if (error) {
        console.warn("[artist_tracks] list failed:", error.message);
        return [];
      }
      return mapRows(data as ArtistCatalogTrack[] | null);
    } catch (error) {
      console.warn("[artist_tracks] unavailable:", error);
      return [];
    }
  },
);

/** Radio rotation source — only radio_ready rows with a public audio URL. */
export const listRadioReadyCatalog = createServerFn({ method: "GET" }).handler(
  async (): Promise<CatalogPlayable[]> => {
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data, error } = await supabaseAdmin
        .from("artist_tracks")
        .select(
          "id, album_id, album_title, artist_name, title, track_number, track_total, audio_url, cover_url, storage_path, genre, credits, division, radio_ready, price_tokens",
        )
        .eq("radio_ready", true)
        .order("album_title", { ascending: true })
        .order("track_number", { ascending: true });
      if (error) {
        console.warn("[artist_tracks] radio list failed:", error.message);
        return [];
      }
      return radioReadyOnly(mapRows(data as ArtistCatalogTrack[] | null));
    } catch (error) {
      console.warn("[artist_tracks] radio unavailable:", error);
      return [];
    }
  },
);
