import { useSyncExternalStore } from "react";
import type { CatalogPlayable } from "@/lib/artist-catalog";

/**
 * One shared HTMLAudioElement for catalog playback so Artist page, album
 * views, and Radio can play the same CDN URLs interchangeably without
 * fighting over multiple elements.
 */
export type CatalogPlaybackState = {
  track: CatalogPlayable | null;
  playing: boolean;
  currentTime: number;
  duration: number;
  owner: "artists" | "radio" | "album" | null;
};

type Listener = () => void;

let audio: HTMLAudioElement | null = null;
let state: CatalogPlaybackState = {
  track: null,
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
  state = { ...state, ...patch };
  emit();
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "metadata";
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
  if (!el || !track.src) return;
  claimCatalogPlayback(owner);
  if (state.track?.id === track.id && el.src) {
    if (el.paused) await el.play().catch(() => setState({ playing: false }));
    else {
      el.pause();
      setState({ playing: false });
    }
    return;
  }
  setState({ track, currentTime: 0, duration: 0, owner, playing: false });
  el.src = track.src;
  await el.play().catch(() => setState({ playing: false }));
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
  return useSyncExternalStore(subscribeCatalogPlayback, getCatalogPlayback, () => state);
}
