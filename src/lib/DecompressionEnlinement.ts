/**
 * Decompression Enlinement — section-aware dynamic range shaping for final render.
 *
 * After dismantel + structure inlining, applies per-section compression /
 * expansion profiles and a true-peak limiting ceiling (-0.3 dB) so choruses
 * punch and sparse sections breathe without inter-sample clipping.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import type { InlinedStructureResult } from "@/lib/MusicStructureInlining";

export type SectionDynamicsInput = {
  sectionName: string;
  /** e.g. -14.0 streaming, -9.0 heavy alternative */
  targetLufs: number;
  /** 0.0 → 1.0 transient emphasis */
  transientPunchRatio: number;
};

export type DecompressionCurve = "LOGARITHMIC" | "LINEAR" | "EXPONENTIAL";

export type AppliedDynamicProfile = {
  sectionName: string;
  compressionThresholdDb: number;
  makeupGainDb: number;
  decompressionCurve: DecompressionCurve;
  targetLufs: number;
  transientPunchRatio: number;
};

export type DecompressionResult = {
  masteringBlueprintId: string;
  appliedDynamicProfiles: AppliedDynamicProfile[];
  peakLimitingCeilingDb: number;
};

const PEAK_LIMITING_CEILING_DB = -0.3;

export class DecompressionEnlinement {
  /**
   * Aligns dynamic range expansion and compression across arrangement sections
   * to ensure breathing room, punch, and zero inter-sample clipping on final render.
   */
  static executeDecompressionEnlinement(
    ctx: ExecutionContext,
    sections: SectionDynamicsInput[],
  ): DecompressionResult {
    const masteringBlueprintId = `decompression_${ctx.sessionNonce}_${Date.now()}`;
    const appliedDynamicProfiles: AppliedDynamicProfile[] = [];
    const safeSections = Array.isArray(sections) ? sections : [];

    for (const section of safeSections) {
      const name = String(section.sectionName || "VERSE").toUpperCase();
      const punch = clamp01(section.transientPunchRatio);
      const targetLufs = Number.isFinite(section.targetLufs) ? section.targetLufs : -14;

      // Tailor dynamic behavior from section role + target loudness / punch.
      let threshold = -18.0;
      let makeup = 3.5;
      let curve: DecompressionCurve = "LOGARITHMIC";

      if (name === "CHORUS" || name === "BRIDGE") {
        // High-energy: gentler threshold, more makeup, exponential breathe.
        threshold = -22.0;
        makeup = 5.2;
        curve = "EXPONENTIAL";
      } else if (name === "INTRO" || name === "OUTRO") {
        // Sparse: tighter dynamic range.
        threshold = -14.0;
        makeup = 2.0;
        curve = "LOGARITHMIC";
      } else if (name === "VERSE") {
        threshold = -18.0;
        makeup = 3.5;
        curve = "LINEAR";
      }

      // Loudness target bias: hotter targets (closer to 0) tighten threshold slightly.
      const lufsBias = Math.max(-6, Math.min(6, (-14 - targetLufs) * 0.35));
      threshold = Number((threshold + lufsBias).toFixed(2));
      // Transient punch adds a touch of makeup for chorus-like impact.
      makeup = Number((makeup + punch * 1.25).toFixed(2));

      appliedDynamicProfiles.push({
        sectionName: name,
        compressionThresholdDb: threshold,
        makeupGainDb: makeup,
        decompressionCurve: curve,
        targetLufs,
        transientPunchRatio: punch,
      });
    }

    return {
      masteringBlueprintId,
      appliedDynamicProfiles,
      peakLimitingCeilingDb: PEAK_LIMITING_CEILING_DB,
    };
  }

  /**
   * Derive section dynamics from an inlined arrangement map + execution tier.
   * Optional genreMasterLufs overrides commercial loudness target from entitlement.
   */
  static deriveSectionDynamicsFromInline(
    ctx: ExecutionContext,
    inlined: InlinedStructureResult,
    options?: { genreMasterLufs?: number },
  ): SectionDynamicsInput[] {
    const streamingLufs = ctx.tier === "enterprise" ? -12 : ctx.tier === "pro" ? -13 : -14;
    const heavyLufs = ctx.tier === "free" ? -11 : -9;
    const genreLufs =
      typeof options?.genreMasterLufs === "number" && Number.isFinite(options.genreMasterLufs)
        ? options.genreMasterLufs
        : null;

    return (inlined.inlinedArrangementMap ?? []).map((seg) => {
      const section = seg.section;
      const isHighEnergy = section === "CHORUS" || section === "BRIDGE";
      const stemCount = Array.isArray(seg.activeStems) ? seg.activeStems.length : 0;
      const barSpan = Math.max(1, seg.endBar - seg.startBar + 1);
      const baseLufs = isHighEnergy ? heavyLufs : streamingLufs;

      return {
        sectionName: section,
        targetLufs: genreLufs ?? baseLufs,
        transientPunchRatio: clamp01(
          isHighEnergy
            ? 0.65 + Math.min(0.3, stemCount * 0.05)
            : section === "INTRO" || section === "OUTRO"
              ? 0.25 + Math.min(0.2, barSpan / 64)
              : 0.45 + Math.min(0.2, stemCount * 0.04),
        ),
      };
    });
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
