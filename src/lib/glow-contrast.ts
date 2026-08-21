/**
 * Contrast guard for the crimson text glow.
 *
 * The glow is decorative light painted *around* glyph edges: on a dark crest it
 * reads as signage, but over a bright or mid-tone crest it lifts the local
 * background luminance and eats the very edge contrast that makes white text
 * legible. These pure helpers estimate the effective luminance behind text
 * (crest, attenuated by the adaptive scrim, plus the glow's own contribution),
 * check it against WCAG AA, and return a clamped glow multiplier plus a flag
 * that switches the stylesheet to a high-contrast fallback.
 */

/** WCAG AA for normal-size body copy. */
export const MIN_CONTRAST_RATIO = 4.5;
/** Relative luminance of the near-black page under the crests. */
const PAGE_LUMINANCE = 0.012;
/** Relative luminance of white text. */
const TEXT_LUMINANCE = 1;
/** Approximate relative luminance of the crimson primary used by the glow. */
const GLOW_LUMINANCE = 0.24;

export type GlowGuard = {
  /**
   * Multiplier (0..1) folded into every glow layer via `--glow-guard`.
   * 1 means the user's chosen strength passes untouched.
   */
  scale: number;
  /** True when the fallback (denser halo, no bloom) should be applied. */
  fallback: boolean;
  /** Estimated contrast ratio of white text at the clamped glow level. */
  ratio: number;
};

export function contrastRatio(a: number, b: number): number {
  const light = Math.max(a, b);
  const dark = Math.min(a, b);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * How much of the crest survives the veil. The scrim multiplier runs roughly
 * 0.6 – 1.55 and each unit covers ~55% of the crest behind text.
 */
export function effectiveBackgroundLuminance(
  crestLuminance: number,
  scrimOpacity: number,
): number {
  const crest = clamp01(crestLuminance);
  const coverage = clamp01(scrimOpacity * 0.55);
  return PAGE_LUMINANCE + (crest - PAGE_LUMINANCE) * (1 - coverage);
}

/** Luminance immediately around a glyph once the glow is painted on top. */
export function glowLiftedLuminance(backgroundLuminance: number, glowStrength: number): number {
  const contribution = clamp01(glowStrength * 0.38) * GLOW_LUMINANCE;
  return clamp01(backgroundLuminance + contribution * (1 - backgroundLuminance));
}

/**
 * Decide how much of the requested glow is safe over the current crest.
 *
 * Walks the glow down in small steps until white text clears AA. If even a
 * glow-free background fails (a genuinely bright crest), the guard drops the
 * glow entirely and flags the fallback so the stylesheet can add a denser dark
 * halo and a more opaque slab instead of coloured light.
 */
export function glowGuard(
  crestLuminance: number,
  scrimOpacity: number,
  glowStrength: number,
): GlowGuard {
  const background = effectiveBackgroundLuminance(crestLuminance, scrimOpacity);
  const requested = Math.max(0, glowStrength);

  if (requested === 0) {
    const ratio = contrastRatio(TEXT_LUMINANCE, background);
    return { scale: 1, fallback: ratio < MIN_CONTRAST_RATIO, ratio: round(ratio) };
  }

  for (let step = 20; step >= 0; step -= 1) {
    const scale = step / 20;
    const ratio = contrastRatio(TEXT_LUMINANCE, glowLiftedLuminance(background, requested * scale));
    if (ratio >= MIN_CONTRAST_RATIO) {
      return { scale, fallback: scale < 1, ratio: round(ratio) };
    }
  }

  const ratio = contrastRatio(TEXT_LUMINANCE, background);
  return { scale: 0, fallback: true, ratio: round(ratio) };
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}
