/**
 * Lock-screen / OS media session for the shared catalog audio element.
 * Artwork falls back to the square USA lockup (`public/brand/lockup-usa-512.png`).
 */

export const CATALOG_MEDIA_ARTWORK_FALLBACK = "/brand/lockup-usa-512.png";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** YouTube stills are 16:9. Lock-screen artwork has to be square. */
const NON_SQUARE_ART =
  /(?:i\.ytimg\.com|img\.youtube\.com|(?:^|\/)(?:maxresdefault|sddefault|hqdefault|mqdefault|default)\.(?:jpe?g|png|webp))/i;

export const MEDIA_SESSION_ACTIONS = ["play", "pause", "seekto", "previoustrack", "nexttrack"] as const;

export type MediaSessionActionName = (typeof MEDIA_SESSION_ACTIONS)[number];

export type CatalogSessionFields = {
  title: string;
  artist?: string | null;
  album?: string | null;
  cover?: string | null;
};

export type CatalogSessionSeekDetails = {
  seekTime?: number | null;
  fastSeek?: boolean;
};

function artworkExtension(src: string): string | null {
  const path = src.split(/[?#]/, 1)[0] ?? "";
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? null;
}

export function artworkMimeType(src: string): string | null {
  const ext = artworkExtension(src);
  if (!ext) return null;
  return MIME_BY_EXT[ext] ?? null;
}

/** http(s) or root-relative png/jpeg/webp. Non-square stills are rejected. */
export function isUsableSessionArtwork(src: string | null | undefined): boolean {
  const raw = src?.trim() ?? "";
  if (!raw || NON_SQUARE_ART.test(raw)) return false;
  if (!artworkMimeType(raw)) return false;
  if (raw.startsWith("/") && !raw.startsWith("//")) return true;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function toAbsoluteArtworkUrl(src: string, origin?: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (!origin) return src;
  try {
    return new URL(src, origin).href;
  } catch {
    return src;
  }
}

export function resolveCatalogMediaArtwork(
  cover: string | null | undefined,
  origin?: string,
): { src: string; type: string } {
  const raw = cover?.trim() ?? "";
  const chosen = isUsableSessionArtwork(raw) ? raw : CATALOG_MEDIA_ARTWORK_FALLBACK;
  const type = artworkMimeType(chosen) ?? "image/png";
  return { src: toAbsoluteArtworkUrl(chosen, origin), type };
}

export function buildCatalogMediaMetadataInit(track: CatalogSessionFields, origin?: string) {
  const artwork = resolveCatalogMediaArtwork(track.cover, origin);
  return {
    title: track.title,
    artist: track.artist?.trim() || "Hybrid AI Records",
    album: track.album?.trim() || "Catalog Master",
    artwork: [{ src: artwork.src, sizes: "512x512", type: artwork.type }],
  };
}

/** `seekTime` of 0 is a real seek. `fastSeek` is ignored. */
export function readSeekTime(details: CatalogSessionSeekDetails | null | undefined): number | null {
  const seekTime = details?.seekTime;
  if (typeof seekTime !== "number" || !Number.isFinite(seekTime)) return null;
  return seekTime;
}

export function getMediaSession(): MediaSession | null {
  if (typeof navigator === "undefined" || !navigator) return null;
  try {
    if (!("mediaSession" in navigator) || !navigator.mediaSession) return null;
  } catch {
    return null;
  }
  return navigator.mediaSession;
}

function sessionOrigin(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return window.location?.origin;
}

export function applyCatalogMediaSession(track: CatalogSessionFields | null, playing: boolean): void {
  const session = getMediaSession();
  if (!session) return;
  if (!track) {
    try {
      session.metadata = null;
    } catch {
      /* ignore */
    }
    try {
      session.playbackState = "none";
    } catch {
      /* ignore */
    }
    return;
  }
  const Metadata =
    typeof globalThis.MediaMetadata === "function" ? globalThis.MediaMetadata : null;
  if (Metadata) {
    try {
      session.metadata = new Metadata(buildCatalogMediaMetadataInit(track, sessionOrigin()));
    } catch {
      /* ignore */
    }
  }
  try {
    session.playbackState = playing ? "playing" : "paused";
  } catch {
    /* ignore */
  }
}

export function setCatalogMediaPlaybackState(playing: boolean): void {
  const session = getMediaSession();
  if (!session) return;
  try {
    session.playbackState = playing ? "playing" : "paused";
  } catch {
    /* ignore */
  }
}

export function installCatalogMediaSessionHandlers(
  onAction: (action: MediaSessionActionName, details?: CatalogSessionSeekDetails) => void,
): void {
  const session = getMediaSession();
  if (!session || typeof session.setActionHandler !== "function") return;
  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      session.setActionHandler(action, (details) => {
        try {
          onAction(action, details);
        } catch {
          /* one action must not break playback */
        }
      });
    } catch {
      /* this action is unsupported in the current browser */
    }
  }
}

export function clearCatalogMediaSessionHandlers(): void {
  const session = getMediaSession();
  if (!session || typeof session.setActionHandler !== "function") return;
  for (const action of MEDIA_SESSION_ACTIONS) {
    try {
      session.setActionHandler(action, null);
    } catch {
      /* ignore */
    }
  }
  try {
    session.metadata = null;
  } catch {
    /* ignore */
  }
  try {
    session.playbackState = "none";
  } catch {
    /* ignore */
  }
}
