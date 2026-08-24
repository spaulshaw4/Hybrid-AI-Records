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
  return raw;
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "auto";
  audio.addEventListener("timeupdate", () => {
    setState({ currentTime: audio?.currentTime ?? 0 });
  });
  audio.addEventListener("loadedmetadata", () => {
    setState({ duration: audio?.duration ?? 0 });
  });
  audio.addEventListener("durationchange", () => {
    setState({ duration: audio?.duration ?? 0 });
  });
  audio.addEventListener("play", () => setState({ playing: true }));
  audio.addEventListener("pause", () => setState({ playing: false }));
  audio.addEventListener("ended", () => setState({ playing: false, currentTime: 0 }));
  audio.addEventListener("error", () => {
    const err = audio?.error;
    console.error("[catalog-player] media error", {
      code: err?.code,
      message: err?.message,
      src: audio?.currentSrc || audio?.src,
    });
    setState({ playing: false });
  });
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
  console.log("Playing audio URL:", track.audio_url ?? track.src, { id: track.id, owner });

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
  if (sameTrack && el.currentSrc) {
    if (el.paused) {
      try {
        await el.play();
        setState({ playing: true, currentTrack: track, track });
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
    await el.play();
    setState({ playing: true, currentTrack: track, track });
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
