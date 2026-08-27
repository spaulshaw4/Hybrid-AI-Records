/**
 * BPM Enlinement — master tempo → millisecond timing grid for mixing tools.
 *
 * After genre entitlement validates BPM bounds, converts tempo into bar/beat/
 * sixteenth grids plus tempo-synced delay and sidechain release times used by
 * structure inlining, lyric cadence, and dynamics downstream.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type BpmEnlinementInput = {
  masterBpm: number;
  /** default 4 */
  timeSignatureNumerator?: number;
  /** default 4 */
  timeSignatureDenominator?: number;
};

export type BpmTimingBlueprint = {
  bpmBlueprintId: string;
  masterBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  barDurationMs: number;
  beatDurationMs: number;
  sixteenthNoteMs: number;
  syncedDelayTimes: {
    quarterNoteMs: number;
    dottedEighthMs: number;
    halfNoteMs: number;
  };
  sidechainReleaseMs: number;
};

export class BpmEnlinement {
  /**
   * Calculates precise millisecond timing grids, subdivision values, and
   * tempo-synced audio parameters based on the master BPM.
   */
  static enlineBpmGrid(ctx: ExecutionContext, input: BpmEnlinementInput): BpmTimingBlueprint {
    const bpmBlueprintId = `bpm_enline_${ctx.sessionNonce}_${Date.now()}`;
    const bpm = clampBpm(input.masterBpm);
    const numerator = Math.max(1, Math.trunc(input.timeSignatureNumerator || 4));
    const denominator = Math.max(1, Math.trunc(input.timeSignatureDenominator || 4));

    // Core timing (ms per beat / bar). Denominator scales beat length vs quarter-note.
    const quarterNoteMs = Number((60_000 / bpm).toFixed(2));
    const beatDurationMs = Number((quarterNoteMs * (4 / denominator)).toFixed(2));
    const barDurationMs = Number((beatDurationMs * numerator).toFixed(2));
    const sixteenthNoteMs = Number((quarterNoteMs / 4).toFixed(2));

    // Tempo-synced effects (rhythm / pumping).
    const dottedEighthMs = Number((quarterNoteMs * 0.75).toFixed(2));
    const halfNoteMs = Number((quarterNoteMs * 2).toFixed(2));

    // Optimal sidechain release — half-beat pump with the kick.
    const sidechainReleaseMs = Number(((60_000 / bpm) * 0.5).toFixed(2));

    return {
      bpmBlueprintId,
      masterBpm: bpm,
      timeSignatureNumerator: numerator,
      timeSignatureDenominator: denominator,
      barDurationMs,
      beatDurationMs,
      sixteenthNoteMs,
      syncedDelayTimes: {
        quarterNoteMs,
        dottedEighthMs,
        halfNoteMs,
      },
      sidechainReleaseMs,
    };
  }
}

function clampBpm(raw: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 120;
  return Math.min(240, Math.max(40, Number(n.toFixed(2))));
}
