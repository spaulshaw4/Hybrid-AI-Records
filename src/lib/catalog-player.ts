import { useSyncExternalStore } from "react";
import type { CatalogPlayable } from "@/lib/artist-catalog";

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
  return (track.audio_url ?? track.src ?? "").trim();
}

function bindElementListeners(el: HTMLAudioElement) {
  if (listenersBound && audio === el) return;
  listenersBound = true;
  el.addEventListener("timeupdate", () => {
    setState({ currentTime: el.currentTime ?? 0 });
  });
  el.addEventListener("loadedmetadata", () => {
    setState({ duration: el.duration ?? 0 });
    console.log("[catalog-player] loadedmetadata", {
      duration: el.duration,
      src: el.currentSrc,
    });
  });
  el.addEventListener("durationchange", () => {
    setState({ duration: el.duration ?? 0 });
  });
  el.addEventListener("play", () => {
    console.log("[catalog-player] state: play", { src: el.currentSrc });
    setState({ playing: true });
  });
  el.addEventListener("pause", () => {
    console.log("[catalog-player] state: pause", { src: el.currentSrc });
    setState({ playing: false });
  });
  el.addEventListener("ended", () => {
    console.log("[catalog-player] state: ended");
    setState({ playing: false, currentTime: 0 });
  });
  el.addEventListener("error", () => {
    const err = el.error;
    console.error("[catalog-player] media error", {
      code: err?.code,
      message: err?.message,
      src: el.currentSrc || el.src,
    });
    setState({ playing: false });
  });
}

/** Bind the root-mounted <audio> from CatalogAudioHost. */
export function bindCatalogAudioElement(el: HTMLAudioElement) {
  audio = el;
  el.preload = "auto";
  bindElementListeners(el);
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audio) {
    bindElementListeners(audio);
    return audio;
  }
  // Fallback if host not mounted yet (still works for same-gesture clicks).
  const existing = document.getElementById("hybrid-catalog-audio");
  if (existing instanceof HTMLAudioElement) {
    bindCatalogAudioElement(existing);
    return existing;
  }
  audio = new Audio();
  audio.preload = "auto";
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
  console.log("Playing audio URL:", track.audio_url ?? track.src, {
    id: track.id,
    owner,
    title: track.title,
  });

  if (!el) {
    console.error("[catalog-player] no Audio element available");
    return;
  }
  if (!url) {
    console.error("[catalog-player] missing audio_url/src for track", track.id, track.title);
    return;
  }

  claimCatalogPlayback(owner);

  const sameTrack = state.currentTrack?.id === track.id || state.track?.id === track.id;
  if (sameTrack && (el.currentSrc || el.src)) {
    if (el.paused) {
      try {
        const p = el.play();
        setState({ playing: true, currentTrack: track, track });
        await p;
      } catch (error) {
        console.error("[catalog-player] play() failed (resume):", error);
        setState({ playing: false });
      }
    } else {
      el.pause();
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
    el.pause();
    el.src = url;
    el.load();
    console.log("[catalog-player] assigned src → play()", {
      src: el.src,
      readyState: el.readyState,
    });
    // Call play() in the same user-gesture turn; await after state update.
    const playPromise = el.play();
    setState({ playing: true, currentTrack: track, track });
    await playPromise;
  } catch (error) {
    console.error("[catalog-player] play() failed:", error, { url });
    setState({ playing: false });
  }
}

export function pauseCatalogPlayback() {
  const el = ensureAudio();
  el?.pause();
  setState({ playing: false });
}

export function seekCatalogPlayback(time: number) {
  const el = ensureAudio();
  if (!el) return;
  const next = Math.max(0, Math.min(time, state.duration || time));
  el.currentTime = next;
  setState({ currentTime: next });
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
