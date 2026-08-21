/**
 * Downbeat extraction from the isolated rhythmic (drum) stem.
 *
 * A simple energy-onset detector: the drum stem is decoded, its short-window
 * RMS envelope is differentiated, peaks above an adaptive threshold become
 * onsets, and the dominant inter-onset interval gives the tempo. Scene cut
 * points are then snapped to the nearest detected downbeat, so the picture
 * cuts land on the track's real bar grid instead of an arbitrary second count.
 */

export type BeatGrid = {
  /** Detected tempo, in BPM. */
  bpm: number;
  /** Downbeat positions, in seconds from 0:00. */
  downbeats: number[];
};

const WINDOW = 1024;

/** Detects onsets + tempo from a decoded rhythmic stem. */
export function analyseRhythm(buffer: AudioBuffer): BeatGrid | null {
  const data = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const frames = Math.floor(data.length / WINDOW);
  if (frames < 8) return null;

  const envelope = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * WINDOW;
    for (let i = 0; i < WINDOW; i++) {
      const sample = data[start + i] ?? 0;
      sum += sample * sample;
    }
    envelope[f] = Math.sqrt(sum / WINDOW);
  }

  // Positive spectral-flux style difference.
  const flux = new Float32Array(frames);
  for (let f = 1; f < frames; f++) {
    flux[f] = Math.max(0, (envelope[f] ?? 0) - (envelope[f - 1] ?? 0));
  }
  const mean = flux.reduce((sum, v) => sum + v, 0) / frames;
  const variance = flux.reduce((sum, v) => sum + (v - mean) ** 2, 0) / frames;
  const threshold = mean + Math.sqrt(variance);

  const secondsPerFrame = WINDOW / rate;
  const onsets: number[] = [];
  let lastOnset = -1;
  for (let f = 1; f < frames - 1; f++) {
    const value = flux[f] ?? 0;
    if (value < threshold) continue;
    if (value < (flux[f - 1] ?? 0) || value < (flux[f + 1] ?? 0)) continue;
    const time = f * secondsPerFrame;
    // 120ms refractory window keeps a single hit from firing twice.
    if (lastOnset >= 0 && time - lastOnset < 0.12) continue;
    onsets.push(Number(time.toFixed(3)));
    lastOnset = time;
  }
  if (onsets.length < 8) return null;

  // Median inter-onset interval → beat period → BPM.
  const gaps = onsets.slice(1).map((t, i) => t - (onsets[i] ?? 0)).filter((g) => g > 0.15 && g < 2);
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  let beat = gaps[Math.floor(gaps.length / 2)] ?? 0.6;
  while (beat < 0.34) beat *= 2; // fold sub-beats up into the 60-180 BPM band
  while (beat > 1.2) beat /= 2;
  const bpm = Math.round(60 / beat);

  // Downbeat = every 4th beat from the first strong onset (4/4).
  const bar = beat * 4;
  const first = onsets[0] ?? 0;
  const downbeats: number[] = [];
  for (let t = first; t < buffer.duration; t += bar) downbeats.push(Number(t.toFixed(3)));

  return { bpm, downbeats };
}

/** Snaps one cut point to the nearest detected downbeat. */
export function snapToDownbeat(seconds: number, grid: BeatGrid | null): number {
  if (!grid?.downbeats.length) return seconds;
  let best = grid.downbeats[0]!;
  for (const beat of grid.downbeats) {
    if (Math.abs(beat - seconds) < Math.abs(best - seconds)) best = beat;
  }
  return Number(best.toFixed(3));
}

/**
 * Snaps a list of shot durations onto the detected downbeat grid while keeping
 * the total exactly equal to `totalSeconds` (no drift, no trailing silence).
 */
export function snapDurationsToDownbeats(
  durations: number[],
  grid: BeatGrid | null,
  totalSeconds: number,
): number[] {
  if (!grid?.downbeats.length || !durations.length) return durations;
  const points: number[] = [];
  let cursor = 0;
  for (const seconds of durations) {
    cursor += seconds;
    points.push(Math.min(totalSeconds, snapToDownbeat(cursor, grid)));
  }
  points[points.length - 1] = Number(totalSeconds.toFixed(3));

  const out: number[] = [];
  let previous = 0;
  for (const point of points) {
    const length = Number((point - previous).toFixed(3));
    if (length > 0.25) {
      out.push(length);
      previous = point;
    }
  }
  return out.length ? out : durations;
}
