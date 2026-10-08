import { useSyncExternalStore } from "react";
import {
  catalogTrackAudioUrl,
  isPlayableCatalogUrl,
  type CatalogPlayable,
} from "@/lib/artist-catalog";
import { safePlay, safeReleaseMediaElement } from "@/lib/safe-media";

/**
 * One shared HTMLAudioElement for catalog playback so Artist page, album
 * views, and Radio can play the same CDN URLs interchangeably without
 * fighting over multiple elements.
 */
export type CatalogPlaybackState = {
  /** @deprecated Prefer currentTrack — kept for existing callers. */
  track: CatalogPlayable | null;
  currentTrack: CatalogPlayable | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  owner: "artists" | "radio" | "album" | "vault" | null;
};

type Listener = () => void;

let audio: HTMLAudioElement | null = null;
let state: CatalogPlaybackState = {
  track: null,
  currentTrack: null,
  playing: false,
  currentTime: 0,
  duration: 0,
  owner: null,
};
const listeners = new Set<Listener>();
const missingListeners = new Set<(trackId: string) => void>();
let listenersBound = false;

/** Drop a track from catalog surfaces after playback finds no audio object. */
export function reportCatalogAudioMissing(trackId: string) {
  if (!trackId) return;
  for (const listener of missingListeners) listener(trackId);
}

export function subscribeCatalogAudioMissing(listener: (trackId: string) => void): () => void {
  missingListeners.add(listener);
  return () => missingListeners.delete(listener);
}

/**
 * True when the URL is empty or the storage host says the object is gone.
 * Supabase Storage answers a missing key with HTTP 400 and a 404 JSON body.
 * A 200 audio response is playable. Network/CORS failures stay playable so a
 * blip does not hide the catalog.
 */
export async function catalogAudioObjectMissing(url: string): Promise<boolean> {
  if (!isPlayableCatalogUrl(url)) return true;
  let head: Response;
  try {
    head = await fetch(url, { method: "HEAD" });
  } catch {
    return false;
  }
  if (head.status === 404) return true;
  if (head.ok) return false;
  const headType = head.headers.get("content-type") ?? "";
  if (headType.startsWith("audio/") || headType.startsWith("video/")) return false;
  if (head.status !== 400 && head.status !== 404) return false;
  try {
    const probe = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-511" },
    });
    if (probe.status === 404) return true;
    const type = probe.headers.get("content-type") ?? "";
    if (probe.ok && (type.startsWith("audio/") || type.startsWith("video/"))) return false;
    const text = (await probe.text()).slice(0, 500);
    return /NoSuchKey|Object not found|"statusCode"\s*:\s*"404"|not_found/i.test(text);
  } catch {
    return false;
  }
}

/** Page-load cache: one HEAD per audio URL, not once per render. */
const storagePresenceCache = new Map<string, boolean>();
const storagePresenceInflight = new Map<string, Promise<boolean>>();

export function clearCatalogStoragePresenceCache() {
  storagePresenceCache.clear();
  storagePresenceInflight.clear();
}

async function storageObjectMissingCached(url: string): Promise<boolean> {
  const cached = storagePresenceCache.get(url);
  if (cached !== undefined) return cached;
  const pending = storagePresenceInflight.get(url);
  if (pending) return pending;
  const check = catalogAudioObjectMissing(url)
    .catch(() => false)
    .then((missing) => {
      storagePresenceCache.set(url, missing);
      storagePresenceInflight.delete(url);
      return missing;
    });
  storagePresenceInflight.set(url, check);
  return check;
}

/**
 * Drop tracks whose storage object is positively missing. A network failure
 * keeps the track. Results are cached for this page load.
 */
export async function omitTracksMissingFromStorage(
  tracks: CatalogPlayable[],
): Promise<CatalogPlayable[]> {
  const limit = 6;
  const missing = new Array<boolean>(tracks.length);
  let next = 0;
  const worker = async () => {
    while (next < tracks.length) {
      const index = next;
      next += 1;
      const url = catalogTrackAudioUrl(tracks[index]);
      try {
        missing[index] = await storageObjectMissingCached(url);
      } catch {
        missing[index] = false;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tracks.length) }, () => worker()),
  );
  return tracks.filter((_, index) => !missing[index]);
}

function emit() {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<CatalogPlaybackState>) {
  const next = { ...state, ...patch };
  if ("track" in patch && !("currentTrack" in patch)) {
    next.currentTrack = patch.track ?? null;
  }
  if ("currentTrack" in patch && !("track" in patch)) {
    next.track = patch.currentTrack ?? null;
  }
  state = next;
  emit();
}

function resolveMediaUrl(url: string): string {
  try {
    const base = typeof window !== "undefined" ? window.location.href : "https://localhost/";
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * Same-track pause/play only when the element still has that exact source.
 * A released element (src attribute removed after a media error) or a new URL
 * must load again — `el.src` stays truthy after release because it resolves
 * against the document.
 */
export function catalogSourceShouldToggle(
  currentTrackId: string | null | undefined,
  nextTrackId: string,
  activeSrc: string,
  nextUrl: string,
): boolean {
  if (!currentTrackId || currentTrackId !== nextTrackId) return false;
  const current = activeSrc.trim();
  const next = nextUrl.trim();
  if (!current || !next) return false;
  return resolveMediaUrl(current) === resolveMediaUrl(next);
}

function playbackUrl(track: CatalogPlayable): string {
  const raw = (track.audio_url ?? track.src ?? "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw, typeof window !== "undefined" ? window.location.origin : "https://localhost");
    if (!["http:", "https:", "blob:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function bindElementListeners(el: HTMLAudioElement) {
  if (listenersBound && audio === el) return;
  listenersBound = true;
  el.addEventListener("timeupdate", () => {
    setState({ currentTime: el.currentTime ?? 0 });
  });
  el.addEventListener("loadedmetadata", () => {
    setState({ duration: el.duration ?? 0 });
  });
  el.addEventListener("durationchange", () => {
    setState({ duration: el.duration ?? 0 });
  });
  el.addEventListener("play", () => {
    setState({ playing: true });
  });
  el.addEventListener("pause", () => {
    setState({ playing: false });
  });
  el.addEventListener("ended", () => {
    setState({ playing: false, currentTime: 0 });
  });
  el.addEventListener("error", () => {
    const err = el.error;
    const failedUrl = (el.currentSrc || el.getAttribute("src") || "").trim();
    const failedId = state.currentTrack?.id ?? state.track?.id ?? null;
    console.warn("[catalog-player] media error", {
      code: err?.code,
      message: err?.message,
      src: failedUrl,
    });
    // Detach the broken source so WebKit stops retrying / heating the device.
    // Read the URL first: release clears src and can fire a second empty error.
    safeReleaseMediaElement(el);
    setState({ playing: false });
    if (!failedId || !isPlayableCatalogUrl(failedUrl)) return;
    void catalogAudioObjectMissing(failedUrl).then((missing) => {
      if (missing) reportCatalogAudioMissing(failedId);
    });
  });
}

/** Bind the root-mounted <audio> from CatalogAudioHost. */
export function bindCatalogAudioElement(el: HTMLAudioElement) {
  audio = el;
  el.preload = "metadata";
  // The attribute is the typed route: `playsInline` is declared on
  // HTMLVideoElement only, though iOS Safari honours it on audio too.
  el.setAttribute("playsinline", "");
  bindElementListeners(el);
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audio) {
    bindElementListeners(audio);
    return audio;
  }
  const existing = document.getElementById("hybrid-catalog-audio");
  if (existing instanceof HTMLAudioElement) {
    bindCatalogAudioElement(existing);
    return existing;
  }
  audio = new Audio();
  audio.preload = "metadata";
  audio.setAttribute("playsinline", "");
  bindElementListeners(audio);
  return audio;
}

/** Expose the shared element for surfaces that still use a local ref (Radio). */
export function getCatalogAudioElement(): HTMLAudioElement | null {
  return ensureAudio();
}

export function getCatalogPlayback(): CatalogPlaybackState {
  return state;
}

export function subscribeCatalogPlayback(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function claimCatalogPlayback(owner: CatalogPlaybackState["owner"]) {
  setState({ owner });
}

export async function playCatalogTrack(
  track: CatalogPlayable,
  owner: NonNullable<CatalogPlaybackState["owner"]>,
): Promise<void> {
  const el = ensureAudio();
  const url = playbackUrl(track);

  if (!el) {
    console.warn("[catalog-player] no Audio element available");
    return;
  }
  if (!url) {
    console.warn("[catalog-player] missing/invalid audio_url for track", track.id);
    reportCatalogAudioMissing(track.id);
    return;
  }

  claimCatalogPlayback(owner);

  const activeSrc = (el.getAttribute("src") || "").trim();
  const currentId = state.currentTrack?.id ?? state.track?.id;
  if (catalogSourceShouldToggle(currentId, track.id, activeSrc, url)) {
    if (el.paused) {
      setState({ playing: true, currentTrack: track, track });
      await safePlay(el);
      if (el.paused) setState({ playing: false });
    } else {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      setState({ playing: false });
    }
    return;
  }

  setState({
    track,
    currentTrack: track,
    currentTime: 0,
    duration: 0,
    owner,
    playing: false,
  });

  try {
    try {
      el.pause();
    } catch {
      /* ignore */
    }
    el.src = url;
    try {
      el.load();
    } catch {
      /* ignore */
    }
    setState({ playing: true, currentTrack: track, track });
    await safePlay(el);
    if (el.paused) setState({ playing: false });
  } catch (error) {
    console.warn("[catalog-player] play() failed:", error, { url });
    safeReleaseMediaElement(el);
    setState({ playing: false });
  }
}

export function pauseCatalogPlayback() {
  const el = ensureAudio();
  try {
    el?.pause();
  } catch {
    /* ignore */
  }
  setState({ playing: false });
}

export function seekCatalogPlayback(time: number) {
  const el = ensureAudio();
  if (!el) return;
  try {
    const next = Math.max(0, Math.min(time, state.duration || time));
    el.currentTime = next;
    setState({ currentTime: next });
  } catch {
    /* ignore */
  }
}

export function useCatalogPlayback(): CatalogPlaybackState {
  return useSyncExternalStore(subscribeCatalogPlayback, getCatalogPlayback, () => ({
    track: null,
    currentTrack: null,
    playing: false,
    currentTime: 0,
    duration: 0,
    owner: null,
  }));
}
