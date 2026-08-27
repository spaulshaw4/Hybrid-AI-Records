/**
 * Interpretive Logic — fast algorithmic intent extraction from prompts.
 *
 * Scans tokens for semantic markers and scores temperature / steps / style
 * deltas in-memory (<1ms). No neural network, no external API cost.
 */

export type DescriptorMods = {
  tempMod: number;
  stepsMod: number;
  styleShift: number;
  /** Optional low-end / texture vectors for provider hints. */
  lowEndEmphasis?: number;
  sampleRateScale?: number;
};

export type InterpretiveResult = {
  tempDelta: number;
  stepsDelta: number;
  styleDelta: number;
  /** 0–100 complexity score for sigmoid intuition curves. */
  complexityScore: number;
  matchedTokens: string[];
  vectors: {
    lowEndEmphasis: number;
    sampleRateScale: number;
  };
};

export class InterpretiveLogic {
  private static DESCRIPTORS: Record<string, DescriptorMods> = {
    // Intensity / mood
    aggressive: { tempMod: 0.1, stepsMod: 20, styleShift: 0.15 },
    heavy: { tempMod: 0.08, stepsMod: 15, styleShift: 0.12, lowEndEmphasis: 0.25 },
    cinematic: { tempMod: 0.06, stepsMod: 25, styleShift: 0.18 },
    epic: { tempMod: 0.07, stepsMod: 22, styleShift: 0.16 },
    dark: { tempMod: 0.04, stepsMod: 10, styleShift: 0.08 },
    dreamy: { tempMod: -0.08, stepsMod: -5, styleShift: -0.06 },
    ambient: { tempMod: -0.15, stepsMod: -10, styleShift: -0.1 },
    chill: { tempMod: -0.12, stepsMod: -12, styleShift: -0.08 },
    soft: { tempMod: -0.1, stepsMod: -15, styleShift: -0.1 },
    // Structure / density
    complex: { tempMod: 0.05, stepsMod: 35, styleShift: 0.2 },
    intricate: { tempMod: 0.05, stepsMod: 30, styleShift: 0.18 },
    minimal: { tempMod: -0.1, stepsMod: -20, styleShift: -0.15 },
    sparse: { tempMod: -0.08, stepsMod: -18, styleShift: -0.12 },
    breakdown: { tempMod: 0.03, stepsMod: 12, styleShift: 0.1 },
    drop: { tempMod: 0.06, stepsMod: 15, styleShift: 0.12 },
    // Tempo / energy
    fast: { tempMod: 0.05, stepsMod: 10, styleShift: 0.05 },
    rapid: { tempMod: 0.06, stepsMod: 12, styleShift: 0.06 },
    slow: { tempMod: -0.08, stepsMod: -8, styleShift: -0.05 },
    groovy: { tempMod: 0.02, stepsMod: 8, styleShift: 0.08 },
    // Texture
    lofi: { tempMod: -0.05, stepsMod: -5, styleShift: -0.08, sampleRateScale: -0.15 },
    "lo-fi": { tempMod: -0.05, stepsMod: -5, styleShift: -0.08, sampleRateScale: -0.15 },
    bass: { tempMod: 0.02, stepsMod: 5, styleShift: 0.04, lowEndEmphasis: 0.2 },
    glitch: { tempMod: 0.09, stepsMod: 18, styleShift: 0.14 },
    warm: { tempMod: -0.03, stepsMod: 0, styleShift: 0.02 },
    raw: { tempMod: 0.07, stepsMod: 8, styleShift: 0.1 },
  };

  /**
   * Interpret prompt tokens → continuous deltas + complexity score.
   * Multi-word phrases (lo-fi, heavy bass) handled via joined bigrams.
   */
  static interpretPrompt(prompt: string): InterpretiveResult {
    const raw = (prompt ?? "").toLowerCase();
    const tokens = raw.split(/\W+/).filter(Boolean);
    const bigrams: string[] = [];
    for (let i = 0; i < tokens.length - 1; i += 1) {
      bigrams.push(`${tokens[i]}-${tokens[i + 1]}`);
      bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
    }

    let tempDelta = 0;
    let stepsDelta = 0;
    let styleDelta = 0;
    let lowEndEmphasis = 0;
    let sampleRateScale = 0;
    const matchedTokens: string[] = [];
    const seen = new Set<string>();

    const apply = (key: string) => {
      const mod = this.DESCRIPTORS[key];
      if (!mod || seen.has(key)) return;
      seen.add(key);
      matchedTokens.push(key);
      tempDelta += mod.tempMod;
      stepsDelta += mod.stepsMod;
      styleDelta += mod.styleShift;
      if (typeof mod.lowEndEmphasis === "number") lowEndEmphasis += mod.lowEndEmphasis;
      if (typeof mod.sampleRateScale === "number") sampleRateScale += mod.sampleRateScale;
    };

    for (const token of tokens) apply(token);
    // Phrase keys stored as lo-fi / heavy handled via token "lofi" + bigram lookup
    for (const phrase of bigrams) {
      if (phrase === "lo-fi" || phrase === "lo fi") apply("lo-fi");
      if (phrase === "heavy-bass" || phrase === "heavy bass") {
        apply("heavy");
        apply("bass");
      }
    }

    // Complexity: token volume + weighted |deltas| → 0..100
    const magnitude =
      Math.abs(tempDelta) * 40 + Math.abs(stepsDelta) / 2 + Math.abs(styleDelta) * 30;
    const lengthScore = Math.min(40, tokens.length * 1.5);
    const complexityScore = Math.max(0, Math.min(100, lengthScore + magnitude * 2 + matchedTokens.length * 8));

    return {
      tempDelta,
      stepsDelta,
      styleDelta,
      complexityScore,
      matchedTokens,
      vectors: {
        lowEndEmphasis: clamp(lowEndEmphasis, -0.5, 0.5),
        sampleRateScale: clamp(sampleRateScale, -0.5, 0.5),
      },
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
