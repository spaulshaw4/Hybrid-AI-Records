/**
 * Responsive source set for the ambient background crests.
 *
 * Only two masters ship in the repo: a 1024px WebP for phones / lite tiers,
 * and a 4096px WebP for unconstrained desktop. Intermediate `/crests/bg/`
 * files were never vendored, so picking 256/384/512 used to 404.
 */

import usa1024 from "@/assets/crests/usa-1024.webp.asset.json";
import lithuania1024 from "@/assets/crests/lithuania-1024.webp.asset.json";
import nigeria1024 from "@/assets/crests/nigeria-1024.webp.asset.json";
import jester1024 from "@/assets/crests/jester-1024.webp.asset.json";
import usa4096 from "@/assets/crests/usa-4096.webp.asset.json";
import lithuania4096 from "@/assets/crests/lithuania-4096.webp.asset.json";
import nigeria4096 from "@/assets/crests/nigeria-4096.webp.asset.json";
import jester4096 from "@/assets/crests/jester-4096.webp.asset.json";

export const CREST_WIDTHS = [1024, 4096] as const;
export type CrestWidth = (typeof CREST_WIDTHS)[number];

export type CrestName = "usa" | "lithuania" | "nigeria" | "jester";

const SHARP_CRESTS: Record<CrestName, string> = {
  usa: usa1024.url,
  lithuania: lithuania1024.url,
  nigeria: nigeria1024.url,
  jester: jester1024.url,
};

const FOUR_K_CRESTS: Record<CrestName, string> = {
  usa: usa4096.url,
  lithuania: lithuania4096.url,
  nigeria: nigeria4096.url,
  jester: jester4096.url,
};

/**
 * URL for one crest at one rendered width.
 *
 * Every variant is WebP: at matched visual quality the small tiers land ~25%
 * lighter than the old JPEGs, which is bandwidth the hero text gets instead.
 */
export function crestUrl(name: CrestName, width: CrestWidth) {
  return width === 4096 ? FOUR_K_CRESTS[name] : SHARP_CRESTS[name];
}

/** `srcset`-style descriptor, useful for <link rel="preload" imagesrcset>. */
export function crestSrcSet(name: CrestName) {
  return CREST_WIDTHS.map((w) => `${crestUrl(name, w)} ${w}w`).join(", ");
}

/**
 * Adaptive crest geometry.
 *
 * The crest masters are square, so the largest edge-to-edge square that fits is
 * `min(vw, vh)` minus a breathing gutter. The gutter itself adapts:
 *
 *  - tall/narrow phones get a small gutter (the crest is width-bound anyway and
 *    should read edge-to-edge across the screen),
 *  - short/wide desktops get a slightly larger one so the wordmark never kisses
 *    the top/bottom chrome,
 *  - extreme aspect ratios (ultrawide, landscape phones) fall back to a ratio of
 *    the *long* edge so the crest never shrinks to a stamp.
 *
 * Returns CSS-ready strings so the stylesheet stays fluid between measurements.
 */
export function pickCrestLayout(opts: {
  viewportWidth: number;
  viewportHeight: number;
  coarse?: boolean;
}) {
  const { viewportWidth: vw, viewportHeight: vh, coarse } = opts;
  const shortEdge = Math.max(1, Math.min(vw, vh));
  const longEdge = Math.max(1, Math.max(vw, vh));
  const aspect = longEdge / shortEdge;

  // Gutter as a fraction of the short edge. Phones: tight. Desktop: roomier.
  // Very lopsided viewports tighten again so the artwork keeps its presence.
  let gutterRatio = coarse || shortEdge < 480 ? 0.02 : shortEdge < 900 ? 0.035 : 0.05;
  if (aspect >= 1.9) gutterRatio = Math.min(gutterRatio, 0.025);

  const gutter = Math.round(shortEdge * gutterRatio);

  // Base square: edge-to-edge on the constraining axis.
  let painted = shortEdge - gutter * 2;

  // On very wide viewports the short edge is the height; allow the crest to
  // exceed it slightly (up to 34% of the long edge) so it still commands the
  // frame instead of floating as a small centred badge.
  if (aspect >= 1.9) painted = Math.max(painted, Math.min(shortEdge, longEdge * 0.34));

  painted = Math.max(160, Math.round(painted));

  return {
    /** Painted CSS-pixel edge of the square crest. */
    paintedPx: painted,
    gutterPx: gutter,
    /** `background-size` value. */
    size: `${painted}px`,
    /** Gutter, exposed for padding-sensitive rules. */
    padding: `${gutter}px`,
  };
}

/**
 * Choose the best-fit bitmap variant for the painted size.
 *
 * Physical pixels = painted CSS px x DPR (capped at 2 — beyond that the extra
 * detail is invisible and only costs memory). We pick the smallest variant that
 * still covers that demand, so the 4K master is fetched only when a smaller
 * edition would have to be enlarged.
 */
export function pickCrestWidth(opts: {
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  constrained?: boolean;
  coarse?: boolean;
}): CrestWidth {
  const { paintedPx } = pickCrestLayout(opts);
  const dpr = Math.min(Math.max(opts.dpr || 1, 1), 2);
  // Constrained / coarse devices accept a touch of upscaling rather than a 4K
  // decode — 4096 WebPs are 1–2.4MB each and overheat mobile Safari GPUs.
  if (opts.constrained || opts.coarse) return 1024;
  const demand = paintedPx * dpr;
  return demand > 1024 ? 4096 : 1024;
}

