/**
 * Advanced generation controls for Hybrid Engine 1.0.
 *
 * MiniMax 2.6 rejects unknown input fields, so tempo, audio influence and
 * weirdness are expressed as deterministic prompt directives instead of raw
 * model parameters. Influence and weirdness still map onto an explicit
 * adherence/temperature pair so the intent is legible in the prompt.
 */

export const MIN_BPM = 60;
export const MAX_BPM = 180;
export const DEFAULT_BPM = 110;

export const MIN_INFLUENCE = 10;
export const MAX_INFLUENCE = 100;
export const DEFAULT_INFLUENCE = 75;

export const MIN_WEIRDNESS = 0;
export const MAX_WEIRDNESS = 100;
export const DEFAULT_WEIRDNESS = 20;

export const MIN_STYLE_INFLUENCE = 0;
export const MAX_STYLE_INFLUENCE = 100;
export const DEFAULT_STYLE_INFLUENCE = 65;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number.isFinite(value) ? value : min)));

export const clampBpm = (bpm: number) => clamp(bpm, MIN_BPM, MAX_BPM);
export const clampInfluence = (v: number) => clamp(v, MIN_INFLUENCE, MAX_INFLUENCE);
export const clampWeirdness = (v: number) => clamp(v, MIN_WEIRDNESS, MAX_WEIRDNESS);
export const clampStyleInfluence = (v: number) =>
  clamp(v, MIN_STYLE_INFLUENCE, MAX_STYLE_INFLUENCE);

/** Plain-language label for how hard the style tags are weighted. */
export function styleInfluenceLabel(value: number): string {
  const v = clampStyleInfluence(value);
  if (v <= 20) return "Loose interpretation";
  if (v <= 45) return "Style-guided";
  if (v <= 70) return "Style-led";
  if (v <= 90) return "Strong genre lock";
  return "Strict genre lock";
}


/** Weirdness 0–100% maps onto a 0.6 → 1.3 temperature / top_p curve. */
export function weirdnessToTemperature(weirdness: number): number {
  const w = clampWeirdness(weirdness) / 100;
  return Math.round((0.6 + w * 0.7) * 100) / 100;
}

export type EngineControls = {
  bpm: number;
  influence: number;
  weirdness: number;
  /** How hard the selected genre/style tags are weighted. */
  styleInfluence?: number;
};

export const DEFAULT_ENGINE_CONTROLS: EngineControls = {
  bpm: DEFAULT_BPM,
  influence: DEFAULT_INFLUENCE,
  weirdness: DEFAULT_WEIRDNESS,
  styleInfluence: DEFAULT_STYLE_INFLUENCE,
};

/** Appends [Tempo], [Style Influence], [Adherence] and [Temperature] directives. */
export function applyEngineControlsToPrompt(prompt: string, controls: EngineControls): string {
  const bpm = clampBpm(controls.bpm);
  const influence = clampInfluence(controls.influence);
  const weirdness = clampWeirdness(controls.weirdness);
  const styleInfluence = clampStyleInfluence(
    controls.styleInfluence ?? DEFAULT_STYLE_INFLUENCE,
  );
  const temperature = weirdnessToTemperature(weirdness);

  const directives = [
    `[Tempo: ${bpm} BPM]`,
    `[Style Influence: ${styleInfluence}% — ${styleInfluenceLabel(styleInfluence)}]`,
    `[Adherence: ${influence}%]`,
    `[Temperature: ${temperature}]`,
  ];

  if (styleInfluence >= 85) {
    directives.push("[Genre Lock: stay strictly inside the listed genre and instrumentation]");
  } else if (styleInfluence <= 20) {
    directives.push("[Freeform: treat the listed genre tags as loose inspiration only]");
  }

  if (weirdness >= 60) {
    directives.push(
      "[Experimental: unconventional sound design, glitch textures, unexpected transitions]",
    );
  }


  return [prompt.trim(), directives.join(" ")].filter(Boolean).join(" ").trim();
}
