import { describe, expect, it, vi } from "vitest";

import {
  bindCatalogAudioElement,
  catalogSourceShouldToggle,
  playCatalogTrack,
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
