import { describe, expect, it, vi } from "vitest";

import {
  bindCatalogAudioElement,
  catalogAudioObjectMissing,
  catalogSourceShouldToggle,
  clearCatalogStoragePresenceCache,
  omitTracksMissingFromStorage,
  playCatalogTrack,
  subscribeCatalogAudioMissing,
} from "@/lib/catalog-player";

describe("catalog source toggle", () => {
  it("toggles only while the same URL is still attached", () => {
    expect(
      catalogSourceShouldToggle("t1", "t1", "https://localhost/a.mp3", "https://localhost/a.mp3"),
    ).toBe(true);
    expect(catalogSourceShouldToggle("t1", "t1", "", "https://localhost/a.mp3")).toBe(false);
    expect(
      catalogSourceShouldToggle("t1", "t1", "https://localhost/a.wav", "https://localhost/a.mp3"),
    ).toBe(false);
    expect(
      catalogSourceShouldToggle("t1", "t2", "https://localhost/a.mp3", "https://localhost/a.mp3"),
    ).toBe(false);
  });

  it("loads a new URL after the element source was released", async () => {
    const el = document.createElement("audio");
    el.play = () => Promise.resolve();
    el.load = () => undefined;
    bindCatalogAudioElement(el);

    const wav = {
      id: "t1",
      title: "Night",
      artist: "Hybrid",
      src: "https://localhost/night.wav",
      audio_url: "https://localhost/night.wav",
    };
    const mp3 = {
      id: "t1",
      title: "Night",
      artist: "Hybrid",
      src: "https://localhost/night.mp3",
      audio_url: "https://localhost/night.mp3",
    };
    await playCatalogTrack(wav, "vault");
    expect(el.getAttribute("src")).toContain("night.wav");

    el.removeAttribute("src");
    await playCatalogTrack(mp3, "vault");
    expect(el.getAttribute("src")).toContain("night.mp3");

    await playCatalogTrack(
      { ...mp3, src: "https://localhost/night-live.mp3", audio_url: "https://localhost/night-live.mp3" },
      "vault",
    );
    expect(el.getAttribute("src")).toContain("night-live.mp3");
    vi.restoreAllMocks();
  });
});

describe("dead catalog audio", () => {
  it("treats an empty url as missing without a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(catalogAudioObjectMissing("")).resolves.toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("treats supabase object-not-found as missing and a 200 file as playable", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "HEAD") {
        return new Response(null, {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          statusCode: "404",
          error: "not_found",
          message: "Object not found",
          code: "NoSuchKey",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(catalogAudioObjectMissing("https://cdn.example/missing.wav")).resolves.toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200, headers: { "content-type": "audio/mpeg" } })),
    );
    await expect(catalogAudioObjectMissing("https://cdn.example/ok.mp3")).resolves.toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps the catalog when a storage check cannot reach the host", async () => {
    clearCatalogStoragePresenceCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    try {
      const kept = await omitTracksMissingFromStorage([
        {
          id: "still-here",
          title: "Still Here",
          artist: "Hybrid",
          album: "Still Here",
          src: "https://cdn.example/still.mp3",
          audio_url: "https://cdn.example/still.mp3",
        },
      ]);
      expect(kept).toHaveLength(1);
      expect(kept[0]?.title).toBe("Still Here");
    } finally {
      vi.unstubAllGlobals();
      clearCatalogStoragePresenceCache();
    }
  });

  it("reports a track with no audio url so the card can leave the list", async () => {
    const missing = vi.fn();
    const stop = subscribeCatalogAudioMissing(missing);
    await playCatalogTrack(
      { id: "golden-eyes-265", title: "Golden Eyes 265", artist: "Hybrid", src: "" },
      "artists",
    );
    expect(missing).toHaveBeenCalledWith("golden-eyes-265");
    stop();
  });
});
