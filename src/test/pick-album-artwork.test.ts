import { describe, expect, it } from "vitest";
import {
  buildArtistCatalogPublicUrl,
  encodeStorageObjectPath,
  pickAlbumArtwork,
} from "@/lib/artist-catalog";

describe("pickAlbumArtwork", () => {
  it("prefers cover.* over other images (case-insensitive)", () => {
    expect(
      pickAlbumArtwork(["Track01.mp3", "Cover.JPG", "photo.png", "notes.txt"]),
    ).toBe("Cover.JPG");
  });

  it("falls back through folder / album_art / front / any image", () => {
    expect(pickAlbumArtwork(["FOLDER.webp", "a.png"])).toBe("FOLDER.webp");
    expect(pickAlbumArtwork(["album_art.jpeg"])).toBe("album_art.jpeg");
    expect(pickAlbumArtwork(["Front.PNG"])).toBe("Front.PNG");
    expect(pickAlbumArtwork(["copilot_image_123.jpeg", "z.png"])).toBe(
      "copilot_image_123.jpeg",
    );
  });

  it("returns null when no images exist", () => {
    expect(pickAlbumArtwork(["a.mp3", "b.wav"])).toBeNull();
  });
});

describe("encodeStorageObjectPath", () => {
  it("encodes spaces in album and file segments", () => {
    expect(encodeStorageObjectPath("Coordinates of Light/The Engine Inside.wav")).toBe(
      "Coordinates%20of%20Light/The%20Engine%20Inside.wav",
    );
    expect(
      buildArtistCatalogPublicUrl(
        "https://example.supabase.co",
        "artist-catalog",
        "Coordinates of Light/col.png",
      ),
    ).toBe(
      "https://example.supabase.co/storage/v1/object/public/artist-catalog/Coordinates%20of%20Light/col.png",
    );
  });
});
