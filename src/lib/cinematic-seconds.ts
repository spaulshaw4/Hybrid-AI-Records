import { MAX_BLOCK_SECONDS } from "@/lib/render-resolution";

/**
 * Motion-block length for the video studio.
 * Rounds to a whole second and clamps to 4–10. It does not snap 5 up to 6,
 * so a 5-second shot stays on Seedance and is never rewritten into Hailuo.
 */
export function clampCinematicSeconds(seconds: number): number {
  const rounded = Math.round(Number(seconds));
  if (!Number.isFinite(rounded)) return 8;
  return Math.max(4, Math.min(MAX_BLOCK_SECONDS, rounded));
}
