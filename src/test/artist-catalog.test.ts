import { describe, expect, it } from "vitest";
import {
  artistTrackToPlayable,
  groupPlayablesAsAlbums,
  isPlayableCatalogUrl,
  mergeCatalogIntoStreamTracks,
  playableToRadioTrack,
  type ArtistCatalogTrack,
  type CatalogPlayable,
} from "@/lib/artist-catalog";
import type { StreamTrack } from "@/lib/radio-tracks";

describe("artist catalog playables", () => {
  const row: ArtistCatalogTrack = {
    id: "gravity-left-behind-the-gravity-well",
    album_id: "gravity-left-behind",
    album_title: "Gravity Left Behind",
    artist_name: "Stephen P. Shaw",
    title: "The Gravity Well",
    track_number: 1,
    track_total: 10,
    audio_url:
      "https://cizvsurntyrrkhndzrpj.supabase.co/storage/v1/object/public/artist-catalog/Gravity%20Left%20Behind/01-The%20Gravity%20Well.mp3",
    cover_url:
      "https://cizvsurntyrrkhndzrpj.supabase.co/storage/v1/object/public/artist-catalog/Gravity%20Left%20Behind/cover.jpg",
    storage_path: "Gravity Left Behind/01-The Gravity Well.mp3",
    genre: "Space Rock",
    credits: "Written by Stephen P. Shaw",
    division: "jester",
    radio_ready: true,
    price_tokens: 1,
  };

  it("accepts public CDN audio URLs", () => {
    expect(isPlayableCatalogUrl(row.audio_url)).toBe(true);
    expect(isPlayableCatalogUrl("/relative.mp3")).toBe(true);
    expect(isPlayableCatalogUrl("")).toBe(false);
  });

  it("maps artist_tracks rows to a shared playable with src = audio_url", () => {
    const playable = artistTrackToPlayable(row);
    expect(playable?.src).toBe(row.audio_url);
    expect(playable?.trackNumber).toBe(1);
    expect(playable?.title).toBe("The Gravity Well");
    expect(playableToRadioTrack(playable!).src).toBe(row.audio_url);
  });

  it("groups playables into album views with ordered tracks", () => {
    const second: CatalogPlayable = {
      ...artistTrackToPlayable(row)!,
      id: "gravity-left-behind-centauri-black",
      title: "Centauri Black",
      trackNumber: 2,
    };
    const albums = groupPlayablesAsAlbums([second, artistTrackToPlayable(row)!]);
    expect(albums).toHaveLength(1);
    expect(albums[0].tracks.map((t) => t.title)).toEqual([
      "The Gravity Well",
      "Centauri Black",
    ]);
    expect(albums[0].tracks[0].src).toBe(row.audio_url);
  });

  it("parses numbered filenames into track number + title", async () => {
    const { parseTrackFilename } = await import("@/lib/artist-catalog");
    expect(parseTrackFilename("01-The Gravity Well.mp3")).toEqual({
      trackNumber: 1,
      title: "The Gravity Well",
    });
    expect(parseTrackFilename("02. Centauri Black.wav")).toEqual({
      trackNumber: 2,
      title: "Centauri Black",
    });
    expect(parseTrackFilename("Africa (2).mp3").title).toBe("Africa");
  });
});
