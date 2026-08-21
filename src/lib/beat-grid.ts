/**
 * Beat grid + timeline clamping.
 *
 * Every shot length is snapped onto the song's bar grid (4/4) so cuts land on
 * musical bars instead of an arbitrary second count, and the total timeline is
 * hard-clamped to the master track's exact duration: surplus shots are dropped
 * and the final shot is trimmed so there is never a silent tail overrun.
 */

/** Fallback tempo when the analyser can't detect one. */
export const DEFAULT_GRID_BPM = 94;

/** Seconds in one 4/4 bar at this tempo (94 BPM → 2.553s). */
export function barSeconds(bpm?: number | null): number {
  const tempo = bpm && bpm > 20 && bpm < 300 ? bpm : DEFAULT_GRID_BPM;
  return (60 / tempo) * 4;
}

/** Snaps an arbitrary length to the nearest whole bar, within min/max bars. */
export function nearestBeatSeconds(
  seconds: number,
  bpm?: number | null,
  options?: { minBars?: number; maxBars?: number },
): number {
  const bar = barSeconds(bpm);
  const minBars = Math.max(1, options?.minBars ?? 1);
  const maxBars = Math.max(minBars, options?.maxBars ?? 3);
  const bars = Math.round(seconds / bar);
  const clamped = Math.min(maxBars, Math.max(minBars, bars || minBars));
  return Number((clamped * bar).toFixed(3));
}

/** Renderable engine block length closest to a bar-snapped duration. */
export function renderableBlock(seconds: number): 4 | 6 | 8 {
  if (seconds >= 7) return 8;
  if (seconds >= 5) return 6;
  return 4;
}

/**
 * Hard-clamps a list of shot durations to the master track duration.
 * Shots that start past the track end are dropped; the last surviving shot is
 * trimmed (and re-snapped down to a whole bar when a bar still fits) so the
 * sum never exceeds `totalSeconds`.
 */
export function clampTimeline(
  durations: number[],
  totalSeconds: number,
  bpm?: number | null,
): number[] {
  const bar = barSeconds(bpm);
  const out: number[] = [];
  let elapsed = 0;
  for (const raw of durations) {
    const remaining = Number((totalSeconds - elapsed).toFixed(3));
    if (remaining <= 0.25) break; // no room left — drop this shot entirely
    let seconds = raw;
    if (seconds > remaining) {
      // Trim: prefer a whole number of bars, otherwise take the exact remainder.
      const bars = Math.floor(remaining / bar);
      seconds = bars >= 1 ? Number((bars * bar).toFixed(3)) : remaining;
    }
    out.push(Number(seconds.toFixed(3)));
    elapsed = Number((elapsed + seconds).toFixed(3));
  }
  return out;
}
