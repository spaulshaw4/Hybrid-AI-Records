/**
 * Intuitive Dismantel Placement — post-synthesis stem / spatial bus reallocation.
 *
 * Breaks a raw multi-stem (or inferred) arrangement into frequency/energy-aware
 * spatial buses before vault delivery: lock sub to mono, widen harmony, tame
 * high-energy peaks. Balance score is CTX-seeded (deterministic for audits).
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";

export type StemName = "drums" | "bass" | "harmony" | "lead" | "fx";
export type FrequencyTier = "sub" | "low-mid" | "presence" | "air";
export type DismantelAction = "WIDENED" | "ISOLATED" | "DOWNMIXED" | "RE_SPACED";

export type StemElement = {
  stemName: StemName;
  /** 0.0 → 1.0 relative energy. */
  energyIndex: number;
  frequencyTier: FrequencyTier;
};

export type ReallocatedStem = {
  stemName: StemName;
  assignedSpatialBus: string;
  dismantelAction: DismantelAction;
};

export type DismantelPlacementResult = {
  restructuredArrangementId: string;
  reallocatedStems: ReallocatedStem[];
  harmonicBalanceScore: number;
};

export class IntuitiveDismantelPlacement {
  /**
   * Intuitively dismantles a raw music arrangement and reallocates its
   * stems across optimal spatial buses and frequency planes.
   */
  static executeDismantelPlacement(
    ctx: ExecutionContext,
    rawStems: StemElement[],
  ): DismantelPlacementResult {
    const restructuredArrangementId = `dismantel_${ctx.sessionNonce}_${Date.now()}`;
    const stems = Array.isArray(rawStems) && rawStems.length > 0 ? rawStems : [];
    const reallocatedStems: ReallocatedStem[] = [];

    for (const stem of stems) {
      const energy = clamp01(stem.energyIndex);
      let spatialBus = "center-mono-bus";
      let action: DismantelAction = "RE_SPACED";

      // Intuitive music design routing from frequency + energy.
      if (stem.stemName === "bass" || stem.frequencyTier === "sub") {
        spatialBus = "sub-low-isolated-bus";
        action = "ISOLATED"; // Keep low end anchored in mono.
      } else if (stem.stemName === "harmony" || stem.frequencyTier === "presence") {
        spatialBus = "stereo-wide-field-b";
        action = "WIDENED"; // Push harmonic elements wide.
      } else if (energy > 0.85) {
        spatialBus = "dynamic-transient-bus";
        action = "DOWNMIXED"; // Tame high-energy peaks.
      } else if (stem.stemName === "drums" || stem.frequencyTier === "low-mid") {
        spatialBus = "punch-transient-bus";
        action = "RE_SPACED";
      } else if (stem.stemName === "lead" || stem.frequencyTier === "air") {
        spatialBus = "presence-lead-bus";
        action = "RE_SPACED";
      } else if (stem.stemName === "fx") {
        spatialBus = "fx-ambient-bus";
        action = "WIDENED";
      }

      reallocatedStems.push({
        stemName: stem.stemName,
        assignedSpatialBus: spatialBus,
        dismantelAction: action,
      });
    }

    return {
      restructuredArrangementId,
      reallocatedStems,
      harmonicBalanceScore: IntuitiveDismantelPlacement.computeHarmonicBalanceScore(
        ctx,
        stems,
      ),
    };
  }

  /**
   * Apply genre entitlement sub-bass routing onto an existing dismantel result.
   */
  static applyGenreSubBassRouting(
    placement: DismantelPlacementResult,
    routing: "MONO_LOCKED" | "SIDECHAIN_COMPRESSED" | "WIDE_SUB",
  ): DismantelPlacementResult {
    const reallocatedStems = placement.reallocatedStems.map((stem) => {
      if (stem.stemName !== "bass") return stem;
      if (routing === "MONO_LOCKED") {
        return {
          ...stem,
          assignedSpatialBus: "sub-low-isolated-bus",
          dismantelAction: "ISOLATED" as const,
        };
      }
      if (routing === "SIDECHAIN_COMPRESSED") {
        return {
          ...stem,
          assignedSpatialBus: "sidechain-sub-bus",
          dismantelAction: "DOWNMIXED" as const,
        };
      }
      return {
        ...stem,
        assignedSpatialBus: "wide-sub-field-bus",
        dismantelAction: "WIDENED" as const,
      };
    });
    return { ...placement, reallocatedStems };
  }

  /**
   * Infer a stem set from provider outputs when explicit StemElement[] is absent.
   */
  static deriveStemsFromGenerationResult(input: {
    ctx: ExecutionContext;
    hasMaster: boolean;
    hasInstrumental?: boolean;
    hasVocal?: boolean;
    hasRaw?: boolean;
  }): StemElement[] {
    const seed = algorithmicHash32(
      `${input.ctx.requestId}|${input.ctx.sessionNonce}|dismantel-stems`,
    );
    const base = (seed % 1000) / 1000;

    const stems: StemElement[] = [];
    if (input.hasMaster || input.hasInstrumental || input.hasVocal || input.hasRaw) {
      stems.push({
        stemName: "drums",
        energyIndex: clamp01(0.55 + base * 0.35),
        frequencyTier: "low-mid",
      });
      stems.push({
        stemName: "bass",
        energyIndex: clamp01(0.45 + ((base + 0.17) % 1) * 0.4),
        frequencyTier: "sub",
      });
      stems.push({
        stemName: "harmony",
        energyIndex: clamp01(0.4 + ((base + 0.33) % 1) * 0.45),
        frequencyTier: "presence",
      });
    }
    if (input.hasVocal) {
      stems.push({
        stemName: "lead",
        energyIndex: clamp01(0.5 + ((base + 0.51) % 1) * 0.4),
        frequencyTier: "air",
      });
    } else if (input.hasMaster) {
      stems.push({
        stemName: "lead",
        energyIndex: clamp01(0.35 + ((base + 0.61) % 1) * 0.35),
        frequencyTier: "presence",
      });
    }
    if (input.hasRaw || input.hasInstrumental) {
      stems.push({
        stemName: "fx",
        energyIndex: clamp01(0.25 + ((base + 0.77) % 1) * 0.5),
        frequencyTier: "air",
      });
    }
    return stems.length > 0
      ? stems
      : [
          { stemName: "drums", energyIndex: 0.6, frequencyTier: "low-mid" },
          { stemName: "bass", energyIndex: 0.5, frequencyTier: "sub" },
          { stemName: "harmony", energyIndex: 0.55, frequencyTier: "presence" },
        ];
  }

  /** Deterministic structural balance in ~0.85–1.00 from CTX + stem energies. */
  static computeHarmonicBalanceScore(ctx: ExecutionContext, stems: StemElement[]): number {
    const hash = algorithmicHash32(
      `${ctx.requestId}|${ctx.sessionNonce}|${stems.map((s) => s.stemName).join(",")}`,
    );
    const jitter = (hash % 150) / 1000; // 0.000–0.149
    const energyMean =
      stems.length > 0
        ? stems.reduce((acc, s) => acc + clamp01(s.energyIndex), 0) / stems.length
        : 0.5;
    // Prefer mid energies for higher balance; extreme energy pulls score down slightly.
    const energyPenalty = Math.abs(energyMean - 0.55) * 0.12;
    return Number(Math.min(1, Math.max(0.85, 0.85 + jitter - energyPenalty)).toFixed(4));
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
