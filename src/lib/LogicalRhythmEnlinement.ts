// src/lib/LogicalRhythmEnlinement.ts
import { createHash } from "node:crypto";

export interface RhythmEnlinementInput {
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  syncopationThreshold: number;
}

export interface RhythmBlueprint {
  rhythmBlueprintId: string;
  subdivisionHierarchy: string[];
  accentPositions: number[];
  swingFactor: number;
  rhythmCoherenceScore: number;
}

export class LogicalRhythmEnlinement {
  public static enlineLogicalRhythm(ctx: any, input: RhythmEnlinementInput): RhythmBlueprint {
    const nonce = ctx?.sessionNonce || "default_nonce";
    const blueprintId = `rhythm_enline_${nonce}_${input.timeSignatureNumerator}_${input.timeSignatureDenominator}`;

    const isCompound = input.timeSignatureNumerator === 6 || input.timeSignatureDenominator === 8;

    const subdivisionHierarchy = isCompound
      ? ["dotted-quarter", "eighth-note"]
      : ["quarter-note", "eighth-note", "sixteenth-note"];

    const accentPositions = isCompound ? [1, 4] : [2, 4];

    const swingFactor = input.syncopationThreshold > 0 
      ? Number((input.syncopationThreshold * 0.24).toFixed(2)) 
      : 0;

    const hashInput = `${nonce}:${input.syncopationThreshold}:${input.timeSignatureNumerator}`;
    const hashVal = this.algorithmicHash32(hashInput);

    // Map hash to [0.97, 0.995]
    const normalizedHash = (hashVal % 1000) / 1000;
    const rhythmCoherenceScore = Number((0.97 + normalizedHash * (0.995 - 0.97)).toFixed(4));

    return {
      rhythmBlueprintId: blueprintId,
      subdivisionHierarchy,
      accentPositions,
      swingFactor,
      rhythmCoherenceScore,
    };
  }

  public static deriveRhythmPatternInput(params: { bpmTiming: any; chaosFactor: number }): RhythmEnlinementInput {
    return {
      timeSignatureNumerator: params.bpmTiming?.timeSignatureNumerator || 4,
      timeSignatureDenominator: params.bpmTiming?.timeSignatureDenominator || 4,
      syncopationThreshold: params.chaosFactor,
    };
  }

  public static algorithmicHash32(str: string): number {
    const hash = createHash("sha256").update(str).digest("hex");
    return parseInt(hash.slice(0, 8), 16);
  }
}
