/**
 * Client-side stem worker driver.
 *
 * Kicked off in the background the moment a master track is ingested. It ships
 * the track to the separation worker, caches the resulting stems for the whole
 * session, decodes the rhythmic stem for downbeat detection, and exposes the
 * isolated vocal stem to the lip-sync stage.
 *
 * Everything here is best-effort: if separation fails the studio keeps working
 * against the full mix.
 */

import { analyseRhythm, type BeatGrid } from "@/lib/downbeats";

export type StemState = {
  status: "idle" | "running" | "ready" | "failed";
  vocalsUrl: string | null;
  drumsUrl: string | null;
  /** Decoded vocal stem, used to slice lip-sync audio per shot. */
  vocalBuffer: AudioBuffer | null;
  grid: BeatGrid | null;
  error: string | null;
};

const EMPTY: StemState = {
  status: "idle",
  vocalsUrl: null,
  drumsUrl: null,
  vocalBuffer: null,
  grid: null,
  error: null,
};

let state: StemState = { ...EMPTY };
let inFlight: Promise<StemState> | null = null;
let currentKey: string | null = null;

const listeners = new Set<(next: StemState) => void>();

export function getStemState(): StemState {
  return state;
}

export function subscribeStems(listener: (next: StemState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function publish(next: Partial<StemState>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener(state));
}

export function resetStems() {
  inFlight = null;
  currentKey = null;
  state = { ...EMPTY };
  listeners.forEach((listener) => listener(state));
}

async function decode(url: string): Promise<AudioBuffer | null> {
  try {
    const AudioCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) return null;
    const ctx = new AudioCtor();
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      return await ctx.decodeAudioData(bytes);
    } finally {
      void ctx.close().catch(() => undefined);
    }
  } catch (err) {
    console.error("[stems] decode failed", err);
    return null;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Starts (or reuses) the background separation run for an ingested file.
 * Safe to call repeatedly — one run per track, single-flight.
 */
export function startStemWorker(file: File): Promise<StemState> {
  const key = `${file.name}|${file.size}|${file.lastModified}`;
  if (currentKey === key && inFlight) return inFlight;
  resetStems();
  currentKey = key;
  publish({ status: "running" });

  inFlight = (async () => {
    try {
      const { separateTrackStems } = await import("@/lib/stems.functions");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await separateTrackStems({
        data: { audioBase64: toBase64(bytes), filename: file.name },
      });
      if (!result.ok) {
        publish({ status: "failed", error: result.error });
        return state;
      }
      publish({ vocalsUrl: result.vocals, drumsUrl: result.drums });

      const [vocalBuffer, drumBuffer] = await Promise.all([
        result.vocals ? decode(result.vocals) : Promise.resolve(null),
        result.drums ? decode(result.drums) : Promise.resolve(null),
      ]);
      const grid = drumBuffer ? analyseRhythm(drumBuffer) : null;
      publish({ status: "ready", vocalBuffer, grid, error: null });
      return state;
    } catch (err) {
      console.error("[stems] worker failed", err);
      publish({
        status: "failed",
        error: err instanceof Error ? err.message : "Stem separation failed.",
      });
      return state;
    }
  })();

  return inFlight;
}
