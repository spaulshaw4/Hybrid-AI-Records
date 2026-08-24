import { describe, expect, it } from "vitest";
import {
  artistTrackToPlayable,
  groupPlayablesAsAlbums,
  isPlayableCatalogUrl,
  mergeCatalogIntoStreamTracks,
  playableToRadioTrack,
  titlesFuzzyMatch,
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

  it("does not append catalog rows that already match static album+title", () => {
    const base: StreamTrack[] = [
      {
        id: "com-whiskey",
        title: "Whiskey",
        artist: "Stacey LA Bradbury",
        album: "A Collection Of Me",
        src: "/static/whiskey.mp3",
        cover: "/cover.jpg",
      },
      {
        id: "kickn-up-dust",
        title: "Kick'N Up Dust",
        artist: "Stephen P. Shaw",
        album: "The Journey",
        src: "/static/kickn.mp3",
        cover: "/cover.jpg",
      },
    ];
    const catalog: CatalogPlayable[] = [
      {
        id: "a-collection-of-me-whiskey",
        title: "Whiskey",
        artist: "Stacey LA Bradbury",
        album: "A Collection Of Me",
        src: "https://cdn.example/whiskey.mp3",
        cover: "https://cdn.example/com.jpg",
        radioReady: true,
      },
      {
        id: "the-journey-kickn-up-dust",
        title: "Kick'N Up Dust",
        artist: "Stephen P. Shaw",
        album: "The Journey",
        src: "https://cdn.example/kickn.mp3",
        cover: "https://cdn.example/journey.jpg",
        radioReady: true,
      },
      {
        id: "only-in-catalog",
        title: "Brand New Song",
        artist: "Stephen P. Shaw",
        album: "The Journey",
        src: "https://cdn.example/new.mp3",
        radioReady: true,
      },
    ];

    const merged = mergeCatalogIntoStreamTracks(base, catalog);
    expect(merged).toHaveLength(3);
    expect(merged.map((t) => t.title)).toEqual([
      "Whiskey",
      "Kick'N Up Dust",
      "Brand New Song",
    ]);
    expect(merged[0].id).toBe("a-collection-of-me-whiskey");
    expect(merged[0].src).toBe("https://cdn.example/whiskey.mp3");
    expect(merged[1].id).toBe("the-journey-kickn-up-dust");
  });

  it("collapses Campfire title drift (punctuation / filler words)", () => {
    expect(
      titlesFuzzyMatch(
        "Bottle of Redemption (Pour Me a Shot of Forgiveness)",
        "Bottle of Redemption(pour me shot of forgiveness )",
      ),
    ).toBe(true);
    expect(titlesFuzzyMatch("Purple Kool-Aid", "Purple Kool Aid")).toBe(true);

    const base: StreamTrack[] = [
      {
        id: "cc-bottle-of-redemption",
        title: "Bottle of Redemption (Pour Me a Shot of Forgiveness)",
        artist: "Phillip S. Thomas",
        album: "Campfire Confessions",
        src: "/static/bottle.mp3",
      },
      {
        id: "cc-purple-kool-aid",
        title: "Purple Kool-Aid",
        artist: "Phillip S. Thomas",
        album: "Campfire Confessions",
        src: "/static/purple.mp3",
      },
    ];
    const catalog: CatalogPlayable[] = [
      {
        id: "campfire-confessions-bottle-of-redemption-pour-me-shot-of-forgiveness",
        title: "Bottle of Redemption(pour me shot of forgiveness )",
        artist: "Phillip S. Thomas",
        album: "Campfire Confessions",
        src: "https://cdn.example/bottle.mp3",
        radioReady: true,
      },
      {
        id: "campfire-confessions-purple-kool-aid",
        title: "Purple Kool Aid",
        artist: "Phillip S. Thomas",
        album: "Campfire Confessions",
        src: "https://cdn.example/purple.mp3",
        radioReady: true,
      },
    ];

    const merged = mergeCatalogIntoStreamTracks(base, catalog);
    expect(merged).toHaveLength(2);
    expect(merged.map((t) => t.id)).toEqual([
      "campfire-confessions-bottle-of-redemption-pour-me-shot-of-forgiveness",
      "campfire-confessions-purple-kool-aid",
    ]);
  });
});
