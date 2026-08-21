/**
 * Global negative prompt applied to EVERY generation call (stills and motion).
 *
 * The character turnaround/triptych sheet is only ever an identity reference —
 * these constraints stop any engine from reproducing the sheet layout itself
 * inside a shot, from multiplying the lead, or from blowing out the exposure.
 */
export const GLOBAL_NEGATIVE_PROMPT =
  "split screen, 3-panel, collage, triptych, turnaround sheet, white studio borders, " +
  "multiple frames, character sheet, multiple subjects, clones, crowd, overexposure, solar flare blowout";

/** Wardrobe continuity negatives — no costume changes between shots. */
export const WARDROBE_NEGATIVE_PROMPT = "shorts, capri pants, white pants, costume change";

/** Merges the global negative constraints into an existing negative prompt. */
export function withGlobalNegative(existing?: string | null): string {
  const extra = (existing ?? "").trim();
  const base = `${GLOBAL_NEGATIVE_PROMPT}, ${WARDROBE_NEGATIVE_PROMPT}`;
  return extra ? `${extra}, ${base}` : base;
}
