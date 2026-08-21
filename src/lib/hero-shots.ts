/**
 * Hero-shot consolidation + edit timeline.
 *
 * Cost control: a project renders 6–8 extended HERO shots of 8–10 seconds each
 * instead of dozens of micro-clips. The editor then cuts those master angles
 * into bar-synced pacing cuts to cover the full track, so the number of billed
 * generation calls no longer scales with song length.
 */

import { barSeconds, clampTimeline } from "@/lib/beat-grid";

/** Hard caps on billed generation calls per project. */
export const MIN_HERO_SHOTS = 6;
export const MAX_HERO_SHOTS = 8;

/** Extended master-angle block length, in seconds. */
export const MIN_HERO_BLOCK = 8;
export const MAX_HERO_BLOCK = 10;

/**
 * Distinct dynamic camera motions, one per hero shot. Every entry describes a
 * moving camera AND moving subject so no shot can come back as a static pose.
 */
export const HERO_CAMERA_MOVES = [
  "smooth low-angle forward tracking shot, camera gliding toward the subject as they walk into frame",
  "sweeping panning jib shot rising over the location, continuous arc from ground level to eye line",
  "handheld walking motion with fluid parallax, foreground elements sliding past the lens",
  "slow orbital dolly circling the subject, background shifting continuously behind them",
  "steadicam push-in from wide to medium, subject moving toward camera with natural gait",
  "lateral tracking shot travelling alongside the subject at speed, motion blur in the background",
  "crane pull-back revealing the wider environment while the subject moves deeper into the frame",
  "gimbal follow shot from behind the shoulder, weaving through the environment with constant motion",
] as const;

/** Camera move assigned to a hero shot index (wraps for safety). */
export function heroCameraMove(index: number): string {
  return HERO_CAMERA_MOVES[index % HERO_CAMERA_MOVES.length]!;
}

/**
 * How many hero shots to render for a track, and how long each block is.
 * Always within the 6–8 shot / 8–10 second envelope.
 */
export function planHeroBlocks(totalSeconds: number, maxShots = MAX_HERO_SHOTS): number[] {
  const cap = Math.max(MIN_HERO_SHOTS, Math.min(MAX_HERO_SHOTS, Math.round(maxShots)));
  const duration = Math.max(1, totalSeconds || 0);
  // Short tracks still get the minimum coverage, but never more shots than the cap.
  const byLength = Math.ceil(duration / 24);
  const count = Math.max(MIN_HERO_SHOTS, Math.min(cap, Math.max(MIN_HERO_SHOTS, byLength)));
  return Array.from({ length: count }, (_, i) =>
    // Alternate 10s / 9s / 8s so the angles differ in length and cut variety.
    i % 3 === 0 ? MAX_HERO_BLOCK : i % 3 === 1 ? 9 : MIN_HERO_BLOCK,
  );
}

export type EditCut = {
  /** Which hero shot this cut is taken from. */
  heroIndex: number;
  /** Start of the cut on the master timeline. */
  start: number;
  /** Length of the cut, snapped to whole bars. */
  seconds: number;
};

/**
 * Bar-synced pacing cuts across the rendered hero angles.
 *
 * The sum of all cuts equals the audio duration exactly (hard clamp, zero
 * trailing silence) — the editor loops back through the master angles rather
 * than rendering more clips.
 */
export function buildEditTimeline(
  heroCount: number,
  totalSeconds: number,
  bpm?: number | null,
  options?: { barsPerCut?: number },
): EditCut[] {
  if (heroCount <= 0 || totalSeconds <= 0) return [];
  const bar = barSeconds(bpm);
  const barsPerCut = Math.max(1, options?.barsPerCut ?? 2);
  const cutLength = Number((bar * barsPerCut).toFixed(3));
  const raw = Array.from(
    { length: Math.ceil(totalSeconds / cutLength) },
    () => cutLength,
  );
  const clamped = clampTimeline(raw, Number(totalSeconds.toFixed(3)), bpm);

  const cuts: EditCut[] = [];
  let start = 0;
  clamped.forEach((seconds, i) => {
    cuts.push({ heroIndex: i % heroCount, start: Number(start.toFixed(3)), seconds });
    start = Number((start + seconds).toFixed(3));
  });

  // Absolute clamp: never exceed the track, never leave a silent tail.
  const total = cuts.reduce((sum, c) => sum + c.seconds, 0);
  const drift = Number((totalSeconds - total).toFixed(3));
  if (cuts.length && Math.abs(drift) > 0.001) {
    const last = cuts[cuts.length - 1]!;
    last.seconds = Number(Math.max(0.05, last.seconds + drift).toFixed(3));
  }
  return cuts;
}
