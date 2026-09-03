/**
 * Recorded Voice Structure Enlinement — snap vocal takes to the master BPM grid.
 *
 * Compares take tempo / transient markers against BpmEnlinement, computes grid
 * snap offsets, and routes vocals to section-specific buses before structure
 * inlining slots them into the arrangement timeline.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import type { BpmTimingBlueprint } from "@/lib/BpmEnlinement";

export type VocalIntendedSection = "VERSE" | "CHORUS" | "BRIDGE" | "INTRO" | "OUTRO";

export type StructuralFitVerdict =
  | "PERFECT_GRID_FIT"
  | "TIMING_COMPENSATED"
  | "REQUIRES_TIME_STRETCH";

export type RecordedVocalTake = {
  takeId: string;
  artistName: string;
  audioDurationSeconds: number;
  detectedBpm: number;
  intendedSection: VocalIntendedSection;
  /** Key vocal start timestamps (ms from take start). */
  transientOffsetsMs: number[];
};

export type StructuredVocalAlignmentResult = {
  alignmentBlueprintId: string;
  takeId: string;
  targetSection: VocalIntendedSection;
  gridSnapOffsetMs: number;
  structuralFitVerdict: StructuralFitVerdict;
  assignedBusRouting: string;
  bpmVariance: number;
  masterBpm: number;
};

export class RecordedVoiceStructureEnlinement {
  /**
   * Enlines recorded vocal takes into the master song structure by snapping
   * transient markers to the BPM grid and assigning section-specific routing.
   */
  static enlineRecordedVocal(
    ctx: ExecutionContext,
    vocalTake: RecordedVocalTake,
    masterBpm: number,
  ): StructuredVocalAlignmentResult {
    const alignmentBlueprintId = `vocal_struct_enline_${ctx.sessionNonce}_${Date.now()}`;
    const bpm = Number.isFinite(masterBpm) && masterBpm > 0 ? masterBpm : 120;
    const beatMs = 60_000 / bpm;

    const firstTransient = Array.isArray(vocalTake.transientOffsetsMs)
      ? vocalTake.transientOffsetsMs[0] || 0
      : 0;
    const gridSnapOffsetMs = Number((firstTransient % beatMs).toFixed(2));

    const detected = Number.isFinite(vocalTake.detectedBpm) ? vocalTake.detectedBpm : bpm;
    const bpmVariance = Number(Math.abs(detected - bpm).toFixed(3));

    let fitVerdict: StructuralFitVerdict = "PERFECT_GRID_FIT";
    if (bpmVariance > 3.0) {
      fitVerdict = "REQUIRES_TIME_STRETCH";
    } else if (bpmVariance > 0.5) {
      fitVerdict = "TIMING_COMPENSATED";
    }

    const section = vocalTake.intendedSection || "VERSE";
    let busRouting = "verse_intimate_vocal_bus";
    if (section === "CHORUS") {
      busRouting = "chorus_stadium_wide_vocal_bus";
    } else if (section === "BRIDGE") {
      busRouting = "bridge_filtered_tension_bus";
    } else if (section === "INTRO") {
      busRouting = "intro_dry_presence_vocal_bus";
    } else if (section === "OUTRO") {
      busRouting = "outro_fade_space_vocal_bus";
    }

    return {
      alignmentBlueprintId,
      takeId: vocalTake.takeId,
      targetSection: section,
      gridSnapOffsetMs,
      structuralFitVerdict: fitVerdict,
      assignedBusRouting: busRouting,
      bpmVariance,
      masterBpm: bpm,
    };
  }

  /**
   * Derive vocal take metadata from studio / provider artifacts when an explicit
   * RecordedVocalTake is not supplied.
   */
  static deriveTakeFromStudioPayload(input: {
    ctx: ExecutionContext;
    bpmTiming: BpmTimingBlueprint;
    voiceId?: unknown;
    referenceAudioUrl?: unknown;
    durationSeconds?: unknown;
    lyrics?: unknown;
    instrumental?: boolean;
    hasVocalStem?: boolean;
  }): RecordedVocalTake | null {
    if (input.instrumental && !input.hasVocalStem) return null;
    if (!input.hasVocalStem && !input.referenceAudioUrl && !input.voiceId && !input.lyrics) {
      return null;
    }

    const duration =
      typeof input.durationSeconds === "number" && Number.isFinite(input.durationSeconds)
        ? Math.max(1, input.durationSeconds)
        : 30;
    const masterBpm = input.bpmTiming.masterBpm;
    const beatMs = input.bpmTiming.beatDurationMs || 60_000 / masterBpm;

    const transientOffsetsMs: number[] = [];
    for (let t = 0; t < duration * 1000 && transientOffsetsMs.length < 32; t += beatMs) {
      transientOffsetsMs.push(Number(t.toFixed(2)));
    }
    if (transientOffsetsMs.length === 0) transientOffsetsMs.push(0);

    const section: VocalIntendedSection = input.lyrics
      ? "VERSE"
      : input.hasVocalStem
        ? "CHORUS"
        : "INTRO";

    return {
      takeId: `take_${input.ctx.sessionNonce}`,
      artistName: String(input.voiceId ?? input.ctx.userId).slice(0, 120),
      audioDurationSeconds: duration,
      detectedBpm: masterBpm,
      intendedSection: section,
      transientOffsetsMs,
    };
  }

  /** Align many takes against the same master BPM. */
  static enlineRecordedVocals(
    ctx: ExecutionContext,
    takes: RecordedVocalTake[],
    masterBpm: number,
  ): StructuredVocalAlignmentResult[] {
    return (Array.isArray(takes) ? takes : []).map((take) =>
      RecordedVoiceStructureEnlinement.enlineRecordedVocal(ctx, take, masterBpm),
    );
  }
}
