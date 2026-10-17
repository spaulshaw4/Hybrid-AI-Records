import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG_MEDIA_ARTWORK_FALLBACK } from "@/lib/catalog-media-session";
import {
  bindCatalogAudioElement,
  bindCatalogSessionTransport,
  dismissCatalogMediaSession,
  playCatalogTrack,
  releaseCatalogMediaSession,
} from "@/lib/catalog-player";

class MediaMetadataMock {
  title = "";
  artist = "";
  album = "";
  artwork: { src: string; sizes: string; type: string }[] = [];

  constructor(init: {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: { src: string; sizes: string; type: string }[];
  }) {
    this.title = init.title ?? "";
    this.artist = init.artist ?? "";
    this.album = init.album ?? "";
    this.artwork = init.artwork ?? [];
  }
}

type SessionHandler = ((details?: { seekTime?: number | null; fastSeek?: boolean }) => void) | null;

function createAudio() {
  const audio = document.createElement("audio");
  let paused = true;
  Object.defineProperty(audio, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(audio, "duration", { configurable: true, get: () => 200 });
  audio.play = () => {
    paused = false;
    audio.dispatchEvent(new Event("play"));
    return Promise.resolve();
  };
  audio.pause = () => {
    paused = true;
    audio.dispatchEvent(new Event("pause"));
  };
  audio.load = () => undefined;
  return audio;
}

const audio = createAudio();

function installSession(failAction?: string) {
  const handlers = new Map<string, SessionHandler>();
  const session = {
    metadata: null as MediaMetadataMock | null,
    playbackState: "none",
    setActionHandler(name: string, handler: SessionHandler) {
      if (failAction && name === failAction && handler) throw new Error(`${name} unsupported`);
      handlers.set(name, handler);
    },
  };
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session,
  });
  return { session, handlers };
}

describe("catalog media session", () => {
  beforeEach(() => {
    releaseCatalogMediaSession();
    vi.stubGlobal("MediaMetadata", MediaMetadataMock);
    bindCatalogAudioElement(audio);
    audio.dispatchEvent(new Event("loadedmetadata"));
  });

  afterEach(() => {
    dismissCatalogMediaSession();
    releaseCatalogMediaSession();
    Reflect.deleteProperty(navigator, "mediaSession");
    vi.unstubAllGlobals();
  });

  it("sets metadata and registers transport handlers when a track becomes current", async () => {
    const { session, handlers } = installSession();
    bindCatalogAudioElement(audio);

    await playCatalogTrack(
      {
        id: "glass-harbor",
        title: "Glass Harbor",
        artist: "",
        album: "   ",
        src: "https://cdn.example/glass-harbor.mp3",
        audio_url: "https://cdn.example/glass-harbor.mp3",
      },
      "artists",
    );

    expect(session.metadata?.title).toBe("Glass Harbor");
    expect(session.metadata?.artist).toBe("Hybrid AI Records");
    expect(session.metadata?.album).toBe("Catalog Master");
    expect(session.metadata?.artwork[0]?.src).toContain(CATALOG_MEDIA_ARTWORK_FALLBACK);
    expect(session.metadata?.artwork[0]?.sizes).toBe("512x512");
    expect(session.metadata?.artwork[0]?.type).toBe("image/png");
    expect(session.playbackState).toBe("playing");
    for (const action of ["play", "pause", "seekto", "previoustrack", "nexttrack"]) {
      expect(handlers.get(action)).toEqual(expect.any(Function));
    }

    await playCatalogTrack(
      {
        id: "coordinates",
        title: "Coordinates of Light",
        artist: "Stephen P. Shaw",
        album: "Coordinates of Light",
        cover: "https://cdn.example/albums/coordinates.webp",
        src: "https://cdn.example/coordinates.mp3",
        audio_url: "https://cdn.example/coordinates.mp3",
      },
      "album",
    );

    expect(session.metadata?.title).toBe("Coordinates of Light");
    expect(session.metadata?.artist).toBe("Stephen P. Shaw");
    expect(session.metadata?.album).toBe("Coordinates of Light");
    expect(session.metadata?.artwork[0]?.src).toBe("https://cdn.example/albums/coordinates.webp");
    expect(session.metadata?.artwork[0]?.type).toBe("image/webp");

    await playCatalogTrack(
      {
        id: "journey",
        title: "The Journey",
        artist: "Hybrid",
        album: "The Journey",
        cover: "/__l5e/assets/the-journey-cover.jpg",
        src: "https://cdn.example/journey.mp3",
        audio_url: "https://cdn.example/journey.mp3",
      },
      "album",
    );
    expect(session.metadata?.artwork[0]?.src).toContain("/__l5e/assets/the-journey-cover.jpg");
    expect(session.metadata?.artwork[0]?.type).toBe("image/jpeg");

    await playCatalogTrack(
      {
        id: "yt-still",
        title: "Wide Still",
        artist: "Hybrid",
        album: "Videos",
        cover: "https://i.ytimg.com/vi/abc/maxresdefault.jpg",
        src: "https://cdn.example/wide.mp3",
        audio_url: "https://cdn.example/wide.mp3",
      },
      "artists",
    );
    expect(session.metadata?.artwork[0]?.src).toContain(CATALOG_MEDIA_ARTWORK_FALLBACK);
    expect(session.metadata?.artwork[0]?.type).toBe("image/png");
  });

  it("seeks, pauses without clearing the card, and steps a registered queue", async () => {
    const { session, handlers } = installSession();
    bindCatalogAudioElement(audio);
    await playCatalogTrack(
      {
        id: "glass-harbor",
        title: "Glass Harbor",
        artist: "Mina",
        album: "Night",
        cover: "https://cdn.example/night.jpg",
        src: "https://cdn.example/glass-harbor.mp3",
        audio_url: "https://cdn.example/glass-harbor.mp3",
      },
      "artists",
    );

    audio.currentTime = 15;
    handlers.get("seekto")?.({ seekTime: undefined, fastSeek: true });
    expect(audio.currentTime).toBe(15);
    handlers.get("seekto")?.({ seekTime: 0, fastSeek: true });
    expect(audio.currentTime).toBe(0);

    handlers.get("previoustrack")?.();
    handlers.get("nexttrack")?.();

    const next = vi.fn();
    const previous = vi.fn();
    const unbind = bindCatalogSessionTransport({
      play: () => {},
      pause: () => {},
      seekTo: () => {},
      next,
      previous,
    });
    handlers.get("nexttrack")?.();
    handlers.get("previoustrack")?.();
    expect(next).toHaveBeenCalledOnce();
    expect(previous).toHaveBeenCalledOnce();
    unbind();

    handlers.get("pause")?.();
    expect(session.playbackState).toBe("paused");
    expect(session.metadata?.title).toBe("Glass Harbor");
    expect(session.metadata?.artist).toBe("Mina");
    expect(session.metadata?.album).toBe("Night");

    dismissCatalogMediaSession();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
  });

  it("keeps going when one action is unsupported and when MediaMetadata is missing", async () => {
    const { session, handlers } = installSession("seekto");
    bindCatalogAudioElement(audio);
    await expect(
      playCatalogTrack(
        {
          id: "still-plays",
          title: "Still Plays",
          artist: "Hybrid",
          album: "Catalog",
          cover: "https://cdn.example/still.png",
          src: "https://cdn.example/still.mp3",
          audio_url: "https://cdn.example/still.mp3",
        },
        "vault",
      ),
    ).resolves.toBeUndefined();

    expect(session.metadata?.title).toBe("Still Plays");
    expect(session.metadata?.artwork[0]?.type).toBe("image/png");
    expect(handlers.get("play")).toEqual(expect.any(Function));
    expect(handlers.get("pause")).toEqual(expect.any(Function));
    expect(handlers.get("seekto")).toBeUndefined();
    expect(handlers.get("nexttrack")).toEqual(expect.any(Function));
    expect(handlers.get("previoustrack")).toEqual(expect.any(Function));

    releaseCatalogMediaSession();
    vi.stubGlobal("MediaMetadata", undefined);
    const second = installSession();
    bindCatalogAudioElement(audio);
    await playCatalogTrack(
      {
        id: "no-metadata-ctor",
        title: "No Constructor",
        artist: "Hybrid",
        src: "https://cdn.example/no-ctor.mp3",
        audio_url: "https://cdn.example/no-ctor.mp3",
      },
      "vault",
    );
    expect(second.session.metadata).toBeNull();
    expect(second.session.playbackState).toBe("playing");
    expect(second.handlers.get("play")).toEqual(expect.any(Function));
  });
});
