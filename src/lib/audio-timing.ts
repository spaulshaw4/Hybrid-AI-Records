/**
 * Story mode audio analysis (browser only).
 *
 * An uploaded song is decoded locally and reduced to a compact timing map:
 * tempo, energy envelope and musical cut points. That map drives the render —
 * scene block lengths snap to the song's transients so the visual cuts land on
 * the music instead of on an arbitrary 8-second grid.
 *
 * Only the map (a few hundred bytes of numbers) ever leaves the browser; the
 * audio file itself is never uploaded.
 */

export type AudioSection = {
  /** Section start in seconds. */
  start: number;
  /** Section end in seconds. */
  end: number;
  /** Structural label inferred from the energy curve. */
  label: "intro" | "build" | "verse" | "chorus" | "drop" | "breakdown" | "outro";
  /** Normalised 0–1 mean energy for the section. */
  energy: number;
};

/**
 * Stem profile from the audio ingestion node. Bands are separated locally and
 * reduced to normalised 0–1 levels; the vocal windows drive lyric timestamp
 * mapping and lip-sync coverage before any script is written.
 */
export type AudioStemProfile = {
  /** Normalised 0–1 mean level of the low band (kick, bass, sub). */
  low: number;
  /** Normalised 0–1 mean level of the mid band (vocal body, keys, guitars). */
  mid: number;
  /** Normalised 0–1 mean level of the high band (hats, air, sibilance). */
  high: number;
  /** Detected transients per second across the whole track. */
  transientDensity: number;
  /** Windows where a lead vocal is present, for lyric mapping and lip-sync. */
  vocalWindows: { start: number; end: number }[];
};

export type AudioTimingMap = {
  /** Track length in seconds. */
  durationSeconds: number;
  /** Estimated tempo, when detectable. */
  bpm: number | null;
  /** Cut points in seconds from the start of the track (ascending). */
  cuts: number[];
  /** Normalised 0–1 energy per cut segment, used to pace the shot language. */
  energy: number[];
  /** Inferred song structure driving the narrative progression. */
  sections: AudioSection[];
  /** Stem separation + transient profile handed to the orchestrator. */
  stems?: AudioStemProfile;
};



const MIN_CUT = 4;
const MAX_CUT = 8;

/** True when this browser can decode audio locally. */
export function canAnalyzeAudio(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) !==
      "undefined"
  );
}

function decodeContext(): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  return new Ctor();
}

/** Mono energy envelope at ~43 frames per second. */
function envelope(buffer: AudioBuffer): { values: Float32Array; frameSeconds: number } {
  const frame = 1024;
  const channel = buffer.getChannelData(0);
  const frames = Math.max(1, Math.floor(channel.length / frame));
  const values = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const start = i * frame;
    for (let j = 0; j < frame; j++) {
      const sample = channel[start + j] ?? 0;
      sum += sample * sample;
    }
    values[i] = Math.sqrt(sum / frame);
  }
  return { values, frameSeconds: frame / buffer.sampleRate };
}

/** Rough tempo from the average spacing of strong energy rises. */
function estimateBpm(rises: number[]): number | null {
  if (rises.length < 8) return null;
  const gaps: number[] = [];
  for (let i = 1; i < rises.length; i++) {
    const gap = rises[i]! - rises[i - 1]!;
    if (gap > 0.2 && gap < 2) gaps.push(gap);
  }
  if (gaps.length < 6) return null;
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)]!;
  let bpm = 60 / median;
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm);
}

/**
 * Decodes a song file and returns its cinematic timing map. Cut points are
 * placed on the strongest transient inside every 4–8 second window so the
 * render's scene blocks change on the beat.
 */
export async function analyzeAudioTiming(file: File): Promise<AudioTimingMap> {
  if (!canAnalyzeAudio()) throw new Error("This browser can't analyse audio locally.");
  if (file.size > 60 * 1024 * 1024) throw new Error("That track is too large — keep it under 60MB.");

  const ctx = decodeContext();
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("Couldn't read that audio file. Try an MP3, WAV or M4A.");
  } finally {
    void ctx.close();
  }

  const { values, frameSeconds } = envelope(buffer);
  const duration = buffer.duration;

  // Positive energy differential = onset strength.
  const flux = new Float32Array(values.length);
  let peak = 0;
  for (let i = 1; i < values.length; i++) {
    const delta = Math.max(0, values[i]! - values[i - 1]!);
    flux[i] = delta;
    if (delta > peak) peak = delta;
  }

  const rises: number[] = [];
  const threshold = peak * 0.35;
  for (let i = 1; i < flux.length; i++) {
    if (flux[i]! >= threshold && flux[i]! >= (flux[i - 1] ?? 0)) rises.push(i * frameSeconds);
  }

  // Walk the track in 4–8s windows, cutting on the loudest transient found.
  const cuts: number[] = [];
  const energy: number[] = [];
  let cursor = 0;
  while (cursor < duration - MIN_CUT) {
    const windowStart = cursor + MIN_CUT;
    const windowEnd = Math.min(duration, cursor + MAX_CUT);
    let best = windowEnd;
    let bestStrength = -1;
    for (let t = windowStart; t <= windowEnd; t += frameSeconds) {
      const strength = flux[Math.floor(t / frameSeconds)] ?? 0;
      if (strength > bestStrength) {
        bestStrength = strength;
        best = t;
      }
    }
    const from = Math.floor(cursor / frameSeconds);
    const to = Math.floor(best / frameSeconds);
    let sum = 0;
    for (let i = from; i < to; i++) sum += values[i] ?? 0;
    const mean = to > from ? sum / (to - from) : 0;
    energy.push(mean);
    cuts.push(Number(best.toFixed(2)));
    cursor = best;
  }

  const loudest = Math.max(0.0001, ...energy);
  const normalised = energy.slice(0, 120).map((e) => Number((e / loudest).toFixed(3)));
  const trimmedCuts = cuts.slice(0, 120);

  return {
    durationSeconds: Number(duration.toFixed(2)),
    bpm: estimateBpm(rises),
    cuts: trimmedCuts,
    energy: normalised,
    sections: detectSections(trimmedCuts, normalised, duration),
    stems: analyzeStems(buffer, rises),

  };
}

/**
 * Groups consecutive cut segments of similar energy into song sections and
 * labels them (intro / build / verse / chorus / drop / breakdown / outro).
 * The label set drives the narrative progression of the render: choruses and
 * drops get the hero imagery, verses carry the story, outros resolve it.
 */
export function detectSections(
  cuts: number[],
  energy: number[],
  duration: number,
): AudioSection[] {
  if (cuts.length < 3) {
    return [{ start: 0, end: Number(duration.toFixed(2)), label: "verse", energy: 0.5 }];
  }

  const band = (e: number) => (e >= 0.72 ? 2 : e >= 0.4 ? 1 : 0);
  const groups: { from: number; to: number; band: number; sum: number; count: number }[] = [];
  let start = 0;

  for (let i = 0; i < cuts.length; i++) {
    const e = energy[i] ?? 0.5;
    const b = band(e);
    const last = groups[groups.length - 1];
    if (last && last.band === b) {
      last.to = cuts[i]!;
      last.sum += e;
      last.count += 1;
    } else {
      groups.push({ from: start, to: cuts[i]!, band: b, sum: e, count: 1 });
    }
    start = cuts[i]!;
  }

  // Merge sections shorter than 8s into their neighbour so the structure stays readable.
  const merged: typeof groups = [];
  for (const g of groups) {
    const prev = merged[merged.length - 1];
    if (prev && g.to - g.from < 8) {
      prev.to = g.to;
      prev.sum += g.sum;
      prev.count += g.count;
    } else {
      merged.push({ ...g });
    }
  }

  return merged.map((g, i) => {
    const mean = g.sum / Math.max(1, g.count);
    const previous = merged[i - 1];
    const first = i === 0;
    const last = i === merged.length - 1;
    let label: AudioSection["label"];
    if (first && g.band < 2) label = "intro";
    else if (last && g.band === 0) label = "outro";
    else if (g.band === 2) label = previous && previous.band === 0 ? "drop" : "chorus";
    else if (g.band === 0) label = "breakdown";
    else label = previous && previous.band === 0 ? "build" : "verse";
    return {
      start: Number(g.from.toFixed(2)),
      end: Number(g.to.toFixed(2)),
      label,
      energy: Number(mean.toFixed(3)),
    };
  });
}

/** Human summary for the studio UI. */
export function describeTiming(map: AudioTimingMap): string {
  const mins = Math.floor(map.durationSeconds / 60);
  const secs = Math.round(map.durationSeconds % 60);
  const avg =
    map.cuts.length > 1 ? map.durationSeconds / map.cuts.length : map.durationSeconds;
  return `${mins}:${String(secs).padStart(2, "0")} • ${map.cuts.length} musical cuts • ~${avg.toFixed(
    1,
  )}s per shot${map.bpm ? ` • ${map.bpm} BPM` : ""}`;
}

/** Stem/transient readout for the studio UI. */
export function describeStems(map: AudioTimingMap): string | null {
  const stems = map.stems;
  if (!stems) return null;
  const mix = `lows ${Math.round(stems.low * 100)}% • mids ${Math.round(
    stems.mid * 100,
  )}% • highs ${Math.round(stems.high * 100)}%`;
  const vocal = stems.vocalWindows.length
    ? `${stems.vocalWindows.length} vocal windows mapped`
    : "no lead vocal detected";
  return `${mix} • ${stems.transientDensity} transients/sec • ${vocal}`;
}

/** Compact "intro → verse → chorus" structure line. */
export function describeStructure(map: AudioTimingMap): string {
  const labels = (map.sections ?? []).map((s) => s.label);
  return labels.length ? labels.join(" → ") : "structure unavailable";
}

/** Formats a section boundary as m:ss. */
export function formatSectionTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}


/**
 * Audio ingestion node — local stem separation and transient profiling.
 *
 * The decoded track is split into low / mid / high bands with single-pole
 * filters, reduced to normalised band levels, and scanned for lead-vocal
 * windows (mid-band presence sustained over the instrumental floor). The
 * result is handed to the orchestrator BEFORE script generation, so the shot
 * list is written against real BPM, transients and vocal timing rather than a
 * guess. The audio itself never leaves the browser.
 */
function analyzeStems(buffer: AudioBuffer, rises: number[]): AudioStemProfile {
  const channel = buffer.getChannelData(0);
  const sampleRate = buffer.sampleRate;
  const frame = 2048;
  const frames = Math.max(1, Math.floor(channel.length / frame));

  // One-pole split: lp = slow follower (lows), hp = residual (highs),
  // mid = band between the two followers.
  const lowCoef = Math.exp((-2 * Math.PI * 160) / sampleRate);
  const midCoef = Math.exp((-2 * Math.PI * 2000) / sampleRate);

  const midFrames = new Float32Array(frames);
  let lowSum = 0;
  let midSum = 0;
  let highSum = 0;
  let lp = 0;
  let mp = 0;

  for (let i = 0; i < frames; i++) {
    const start = i * frame;
    let low = 0;
    let mid = 0;
    let high = 0;
    for (let j = 0; j < frame; j++) {
      const sample = channel[start + j] ?? 0;
      lp = lowCoef * lp + (1 - lowCoef) * sample;
      mp = midCoef * mp + (1 - midCoef) * sample;
      const midBand = mp - lp;
      const highBand = sample - mp;
      low += lp * lp;
      mid += midBand * midBand;
      high += highBand * highBand;
    }
    const lowRms = Math.sqrt(low / frame);
    const midRms = Math.sqrt(mid / frame);
    const highRms = Math.sqrt(high / frame);
    midFrames[i] = midRms;
    lowSum += lowRms;
    midSum += midRms;
    highSum += highRms;
  }

  const loudest = Math.max(0.0001, lowSum / frames, midSum / frames, highSum / frames);
  const frameSeconds = frame / sampleRate;

  // Lead-vocal windows: sustained mid-band presence above the track's own floor.
  const sorted = Array.from(midFrames).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.45)] ?? 0;
  const gate = floor * 1.6;
  const windows: { start: number; end: number }[] = [];
  let openedAt: number | null = null;
  for (let i = 0; i < frames; i++) {
    const active = (midFrames[i] ?? 0) >= gate;
    if (active && openedAt === null) openedAt = i * frameSeconds;
    if (!active && openedAt !== null) {
      const end = i * frameSeconds;
      if (end - openedAt >= 1.5) windows.push({ start: Number(openedAt.toFixed(2)), end: Number(end.toFixed(2)) });
      openedAt = null;
    }
  }
  if (openedAt !== null) {
    windows.push({ start: Number(openedAt.toFixed(2)), end: Number(buffer.duration.toFixed(2)) });
  }

  return {
    low: Number((lowSum / frames / loudest).toFixed(3)),
    mid: Number((midSum / frames / loudest).toFixed(3)),
    high: Number((highSum / frames / loudest).toFixed(3)),
    transientDensity: Number((rises.length / Math.max(1, buffer.duration)).toFixed(2)),
    vocalWindows: windows.slice(0, 40),
  };
}
