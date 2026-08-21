/**
 * Adaptive scrim strength for the living background.
 *
 * The crests differ wildly in brightness — the Lithuanian shield peaks far
 * lighter than the Jester matrix — so a single fixed veil either washes out the
 * dark crests or lets the bright ones swallow headlines. These helpers measure
 * how bright the crest currently peaking actually is and translate that into a
 * veil opacity plus a backdrop blur radius, applied as CSS custom properties.
 *
 * Pure functions live here so the mapping is testable without a DOM.
 */

/** Relative-luminance weights (Rec. 709), matching perceived brightness. */
const R_W = 0.2126;
const G_W = 0.7152;
const B_W = 0.0722;

export type ScrimStrength = {
  /** Multiplier applied to the veil's base opacity (0.6 – 1.55). */
  opacity: number;
  /** Backdrop blur radius in px applied behind text (0 – 10). */
  blur: number;
};

/**
 * Map mean crest luminance (0..1) to scrim strength.
 *
 * Dark crests barely need help, so the veil backs off and lets them read.
 * Bright crests get a heavier veil plus a little blur, which kills the
 * high-frequency detail that makes body copy hard to track.
 */
export function scrimForLuminance(luminance: number): ScrimStrength {
  const l = Math.min(1, Math.max(0, luminance));
  // Below this the background is already dark enough for white text.
  const floor = 0.12;
  // Above this we are at maximum protection.
  const ceiling = 0.55;
  const t = Math.min(1, Math.max(0, (l - floor) / (ceiling - floor)));
  const eased = t * t * (3 - 2 * t); // smoothstep — no abrupt jumps mid-fade

  return {
    opacity: round(0.62 + eased * 0.93),
    blur: round(eased * 10),
  };
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/**
 * Which layer is peaking right now, given a cycle length shared by all layers
 * and evenly spaced negative delays (layer i is offset by i * cycle / count).
 */
export function activeLayerIndex(elapsedMs: number, count: number, cycleMs: number): number {
  if (count <= 1 || cycleMs <= 0) return 0;
  const slot = cycleMs / count;
  const phase = ((elapsedMs % cycleMs) + cycleMs) % cycleMs;
  return Math.floor(phase / slot) % count;
}

/**
 * Mean relative luminance of an image, sampled from a tiny offscreen canvas.
 *
 * Downsampling to 24px means one cheap GPU-assisted draw plus ~576 pixel reads
 * instead of megapixels of work, and transparent pixels are weighted by alpha
 * because they composite over the dark page rather than adding brightness.
 */
export function measureImageLuminance(img: HTMLImageElement, size = 24): number | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const { data } = ctx.getImageData(0, 0, size, size);

    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      sum += ((R_W * data[i] + G_W * data[i + 1] + B_W * data[i + 2]) / 255) * a;
    }
    return sum / (data.length / 4);
  } catch {
    // Tainted canvas or no 2d context: caller keeps the default scrim.
    return null;
  }
}
