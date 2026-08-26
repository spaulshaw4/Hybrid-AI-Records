import { useSyncExternalStore } from "react";
import type { CatalogPlayable } from "@/lib/artist-catalog";
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
  owner: "artists" | "radio" | "album" | null;
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
let listenersBound = false;

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
    console.warn("[catalog-player] media error", {
      code: err?.code,
      message: err?.message,
      src: el.currentSrc || el.src,
    });
    // Detach the broken source so WebKit stops retrying / heating the device.
    safeReleaseMediaElement(el);
    setState({ playing: false });
  });
}

/** Bind the root-mounted <audio> from CatalogAudioHost. */
export function bindCatalogAudioElement(el: HTMLAudioElement) {
  audio = el;
  el.preload = "metadata";
  el.setAttribute("playsinline", "");
  el.playsInline = true;
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
  audio.playsInline = true;
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
    return;
  }

  claimCatalogPlayback(owner);

  const sameTrack = state.currentTrack?.id === track.id || state.track?.id === track.id;
  if (sameTrack && (el.currentSrc || el.src)) {
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
