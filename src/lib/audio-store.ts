import { useSyncExternalStore } from "react";
import type { AudioTimingMap } from "@/lib/audio-timing";

/**
 * Global master-audio handoff.
 *
 * The song is dropped exactly once at the front door (Station 1). Every later
 * stage — Gemini orchestration, the Replicate dispatch payload and the local
 * ffmpeg-wasm mux — reads the same File from here. No stage ever asks the
 * producer to pick a file again.
 */
export type MasterAudio = {
  file: File;
  name: string;
  /** Object URL for playback/mux. Revoked when the track is replaced. */
  url: string;
  timing: AudioTimingMap | null;
};

let state: MasterAudio | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read the current master track outside React (server functions, handlers). */
export function getMasterAudio(): MasterAudio | null {
  return state;
}

/** Store the track dropped at the front door. Replaces any previous upload. */
export function setMasterAudio(
  file: File | null,
  name: string | null,
  timing: AudioTimingMap | null,
): MasterAudio | null {
  if (state?.url) URL.revokeObjectURL(state.url);
  if (!file) {
    state = null;
  } else {
    state = {
      file,
      name: name ?? file.name,
      url: URL.createObjectURL(file),
      timing,
    };
  }
  emit();
  return state;
}

/** Update only the analysed timing map for the already-stored track. */
export function setMasterAudioTiming(timing: AudioTimingMap | null) {
  if (!state) return;
  state = { ...state, timing };
  emit();
}

export function clearMasterAudio() {
  setMasterAudio(null, null, null);
}

/** Subscribe a component to the globally stored master track. */
export function useMasterAudio(): MasterAudio | null {
  return useSyncExternalStore(subscribe, getMasterAudio, () => null);
}
