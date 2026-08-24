/**
 * Standard fallback handlers for Gates 3, 5, and 6.
 * Soft-fail paths keep the track alive when CWALO / Fish / dynamic remux trip.
 */

import {
  FALLBACK_CWALO_DEFAULT_STRUCTURE,
  FALLBACK_FISH_AUDIO_RAW_VOCALS,
  type Gate3Result,
  type Gate5Result,
  type MusicSectionMarker,
} from "@/types/pipeline";

/**
 * Gate 3 fallback — standard section template when CWALO times out or fails.
 */
export function generateDefaultStructure(
  estimatedDurationSec = 180,
  trackId = "",
): Gate3Result {
  console.warn("[Fallback Triggered] Applying standard structural template for Gate 3.");

  const end = Math.max(estimatedDurationSec, 150);
  const markers: MusicSectionMarker[] = [
    { label: "intro", start: 0, end: 15, energyLevel: 0.6 },
    { label: "verse", start: 15, end: 45, energyLevel: 0.7 },
    { label: "chorus", start: 45, end: 75, energyLevel: 0.95 },
    { label: "verse", start: 75, end: 105, energyLevel: 0.75 },
    { label: "chorus", start: 105, end: Math.min(140, end), energyLevel: 1.0 },
    { label: "outro", start: Math.min(140, end), end, energyLevel: 0.8 },
  ];

  return {
    trackId,
    isFallback: true,
    markers,
    bpm: 120,
    key: "C",
  };
}

export { FALLBACK_CWALO_DEFAULT_STRUCTURE, FALLBACK_FISH_AUDIO_RAW_VOCALS };

/**
 * Gate 5 fallback — download the unmodified Demucs vocal stem when Fish fails.
 */
export async function fetchRawVocalFallback(
  vocalStemUrl: string,
  trackId = "",
): Promise<Gate5Result> {
  console.warn(
    "[Fallback Triggered] Fish Audio failed or timed out. Falling back to clean Demucs vocal stem.",
  );

  if (!/^https?:\/\//i.test(vocalStemUrl)) {
    throw new Error("fetchRawVocalFallback requires an http(s) Demucs vocal URL.");
  }

  const response = await fetch(vocalStemUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`fetchRawVocalFallback failed (${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1024) {
    throw new Error("fetchRawVocalFallback returned an empty vocal buffer.");
  }

  return {
    trackId,
    convertedVocalBuffer: bytes,
    isFallback: true,
  };
}

/**
 * Static FFmpeg remux when section-aware (CWALO) mastering fails.
 * Forces 44.1 kHz stereo + duration=first, then EBU R128 loudnorm (-14 LUFS / -1.0 dBTP).
 */
export const STATIC_MASTER_FFMPEG_FILTER =
  "[0:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a0];" +
  "[1:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a1];" +
  "[a0][a1]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixed];" +
  "[mixed]loudnorm=I=-14:LRA=7:TP=-1.0,alimiter=limit=0.891250938:level=false[out]";

/** Build argv for a static (non-CWALO) two-stem FFmpeg master. */
export function buildStaticMasterFfmpegArgs(
  instrumentalPath: string,
  vocalPath: string,
  outputWav: string,
): string[] {
  return [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    instrumentalPath,
    "-i",
    vocalPath,
    "-filter_complex",
    STATIC_MASTER_FFMPEG_FILTER,
    "-map",
    "[out]",
    "-shortest",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s24le",
    "-f",
    "wav",
    outputWav,
  ];
}
