// src/lib/BpmEnlinement.ts
import { createHash } from "node:crypto";

export interface BpmEnlinementInput {
  masterBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
}

export interface BpmBlueprint {
  bpmBlueprintId: string;
  masterBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridResolution: string;
}

export class BpmEnlinement {
  public static enlineBpmGrid(ctx: any, input: BpmEnlinementInput): BpmBlueprint {
    const nonce = ctx?.sessionNonce || "default_nonce";
    const blueprintId = `bpm_enline_${nonce}_${input.masterBpm}`;

    return {
      bpmBlueprintId: blueprintId,
      masterBpm: input.masterBpm,
      timeSignatureNumerator: input.timeSignatureNumerator,
      timeSignatureDenominator: input.timeSignatureDenominator,
      gridResolution: "1/16",
    };
  }

  public static algorithmicHash32(str: string): number {
    const hash = createHash("sha256").update(str).digest("hex");
    return parseInt(hash.slice(0, 8), 16);
  }
}
