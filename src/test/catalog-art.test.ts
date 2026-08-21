import { describe, expect, it } from "vitest";
import {
  albumCoverSrc,
  catalogArtSrc,
  coverForCatalogTitle,
  videoPosterFallbacks,
  videoPosterSrc,
} from "@/lib/radio-tracks";

describe("catalog album artwork", () => {
  it("resolves album covers from catalog titles", () => {
    expect(coverForCatalogTitle("Voices Before The Fall")).toBeTruthy();
    expect(coverForCatalogTitle("Coordinates Of Light")).toBeTruthy();
    expect(coverForCatalogTitle("Never Missed A Beat")).toBeTruthy();
    expect(coverForCatalogTitle("The Bill Collector's Nebula")).toBeTruthy();
    expect(coverForCatalogTitle("The Red")).toBeTruthy();
  });

  it("keeps video posters on YouTube even when album art exists", () => {
    const id = "F5XrwINZiJY";
    expect(videoPosterSrc(id)).toBe(`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`);
    expect(videoPosterSrc(id)).not.toBe(coverForCatalogTitle("Coordinates Of Light"));
  });

  it("looks up album art for a video title when no explicit cover is set", () => {
    expect(albumCoverSrc({ title: "The Ringer" })).toBe(coverForCatalogTitle("The Ringer"));
  });

  it("prefers an explicit cover over a lookup", () => {
    const explicit = catalogArtSrc({ id: "abc", title: "The Red", cover: "/explicit.jpg" });
    expect(explicit).toBe("/explicit.jpg");
  });

  it("falls back to a YouTube thumbnail when no album art exists", () => {
    expect(catalogArtSrc({ id: "zzzzzzzzzzz", title: "A Song That Does Not Exist" })).toBe(
      "https://i.ytimg.com/vi/zzzzzzzzzzz/maxresdefault.jpg",
    );
  });

  it("offers SD then HQ YouTube stills when the HD frame is missing", () => {
    expect(videoPosterFallbacks("abc")).toEqual([
      "https://i.ytimg.com/vi/abc/sddefault.jpg",
      "https://i.ytimg.com/vi/abc/hqdefault.jpg",
    ]);
  });
});
