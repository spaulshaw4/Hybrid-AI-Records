/**
 * Resolution + budget safeguards for every visual render.
 *
 * Native render targets are capped at 1080p. Anything higher is an upscale
 * step, never a native generation — "8K native" burns GPU compute and drains
 * render credit for detail no delivery pipeline actually keeps.
 */

/** The only native target the pipeline will ever request. */
export const NATIVE_RENDER_RESOLUTION = "1080p" as const;

/**
 * Native ceiling for the omni-modal node, which generates picture and
 * synchronised stereo audio in one pass and is rated up to 2K at 24fps.
 */
export const OMNI_RENDER_RESOLUTION = "2k" as const;

/** Frame size used for foundation stills and motion blocks. */
export const NATIVE_RENDER_SIZE = "1920x1080" as const;

/** Highest delivery target, reached by upscaling a 1080p master — never native. */
export const MAX_DELIVERY_RESOLUTION = "4K (upscaled from 1080p)" as const;

/** Longest single motion block, in seconds — keeps per-shot spend predictable. */
export const MAX_BLOCK_SECONDS = 10;

/**
 * Strips resolution inflation out of any prompt text before it reaches a paid
 * model: "8k", "12k", "16k resolution" and friends all collapse to the capped
 * 4K wording so no prompt can talk an engine into a native 8K pass.
 */
export function clampResolutionLanguage(prompt: string): string {
  return prompt
    .replace(/\b(?:8|10|12|16)\s?-?\s?k\b(?:\s+(?:native|resolution|render|uhd))?/gi, "4K")
    .replace(/\bnative\s+4K\b/gi, "4K")
    .replace(/\s{2,}/g, " ")
    .trim();
}
