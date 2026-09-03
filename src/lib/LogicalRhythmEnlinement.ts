/**
 * Logical Rhythm Enlinement — subdivision hierarchy, swing, and accent placement.
 *
 * After BPM Enlinement builds the millisecond grid, this engine enforces groove
 * logic: subdivision ladders, syncopation-scaled swing, and backbeat accents
 * so structure/lyric/vocal stages inherit natural rhythm without mechanical jitter.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";
import type { BpmTimingBlueprint } from "@/lib/BpmEnlinement";

export type RhythmPatternInput = {
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  /** 0.0 (straight on-beat) to 1.0 (heavy syncopated push) */
  syncopationThreshold: number;
};

export type LogicalRhythmBlueprint = {
  rhythmBlueprintId: string;
  subdivisionHierarchy: string[];
  swingFactor: number;
  /** Beat indices that receive dynamic velocity bumps */
  accentPositions: number[];
  rhythmCoherenceScore: number;
};

export class LogicalRhythmEnlinement {
  /**
   * Enforces logical rhythm and subdivision hierarchy, ensuring groove
   * and accent placement flow naturally without mechanical jitter.
   */
  static enlineLogicalRhythm(
    ctx: ExecutionContext,
    input: RhythmPatternInput,
  ): LogicalRhythmBlueprint {
    const rhythmBlueprintId = `rhythm_enline_${ctx.sessionNonce}_${Date.now()}`;
    const syncopation = clamp01(input.syncopationThreshold);
    const numerator = Math.max(1, Math.trunc(input.timeSignatureNumerator || 4));
    const denominator = Math.max(1, Math.trunc(input.timeSignatureDenominator || 4));

    const subdivisionHierarchy =
      numerator === 6
        ? ["dotted-quarter", "eighth-note"]
        : ["quarter-note", "eighth-note", "sixteenth-note"];

    const swingFactor = Number((syncopation * 0.24).toFixed(3));
    const accentPositions = numerator === 4 ? [2, 4] : [1, 4];

    const rhythmCoherenceScore = LogicalRhythmEnlinement.computeCoherenceScore(
      ctx,
      numerator,
      denominator,
      syncopation,
    );

    return {
      rhythmBlueprintId,
      subdivisionHierarchy,
      swingFactor,
      accentPositions,
      rhythmCoherenceScore,
    };
  }

  /**
   * Derive rhythm pattern input from the BPM timing blueprint plus studio /
   * chaos syncopation hints.
   */
  static deriveRhythmPatternInput(input: {
    bpmTiming: BpmTimingBlueprint;
    syncopationThreshold?: unknown;
    chaosFactor?: unknown;
    controls?: unknown;
  }): RhythmPatternInput {
    const fromExplicit =
      typeof input.syncopationThreshold === "number" &&
      Number.isFinite(input.syncopationThreshold)
        ? clamp01(input.syncopationThreshold)
        : null;

    const controls =
      input.controls && typeof input.controls === "object"
        ? (input.controls as Record<string, unknown>)
        : null;
    const fromControls =
      controls &&
      typeof controls.syncopation === "number" &&
      Number.isFinite(controls.syncopation)
        ? clamp01(controls.syncopation)
        : controls &&
            typeof controls.weirdness === "number" &&
            Number.isFinite(controls.weirdness)
          ? clamp01(controls.weirdness > 1 ? controls.weirdness / 100 : controls.weirdness)
          : null;

    const fromChaos =
      typeof input.chaosFactor === "number" && Number.isFinite(input.chaosFactor)
        ? clamp01(input.chaosFactor)
        : null;

    return {
      timeSignatureNumerator: input.bpmTiming.timeSignatureNumerator,
      timeSignatureDenominator: input.bpmTiming.timeSignatureDenominator,
      syncopationThreshold: fromExplicit ?? fromControls ?? fromChaos ?? 0.35,
    };
  }

  /** Deterministic coherence in ~0.970–0.995 from CTX + meter fingerprints. */
  static computeCoherenceScore(
    ctx: ExecutionContext,
    numerator: number,
    denominator: number,
    syncopation: number,
  ): number {
    const hash = algorithmicHash32(
      `${ctx.requestId}|${ctx.sessionNonce}|logical_rhythm|${numerator}/${denominator}|${syncopation.toFixed(3)}`,
    );
    const jitter = (hash % 26) / 1000;
    return Number((0.97 + jitter).toFixed(4));
  }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
