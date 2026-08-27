/**
 * Wierdness Enlinement — controlled analog anomalies from chaos factor.
 *
 * After genre/BPM/lyric locks, injects micro-detune, tape wobble, spectral
 * saturation, and granular scatter so the mix sheds sterile digital precision.
 * Spelling matches the product dialect ("wierdness").
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type WierdnessTargetElement =
  | "SYNTH_PADS"
  | "VOCAL_LAYERS"
  | "GUITAR_TRANSIENTS"
  | "MASTER_BUS";

export type WierdnessVerdict =
  | "SUBTLE_CHARACTER"
  | "EXPERIMENTAL_DRIFT"
  | "RADICAL_ALTERATION";

export type WierdnessInput = {
  /** 0.0 clinical → 1.0 fully experimental */
  chaosFactor: number;
  targetElement: WierdnessTargetElement;
};

export type WierdnessBlueprint = {
  wierdnessBlueprintId: string;
  appliedChaosFactor: number;
  targetElement: WierdnessTargetElement;
  anomalyParameters: {
    microPitchDetuneCents: number;
    tapeWobbleDepth: number;
    spectralSaturationDrive: number;
    granularScatterSpreadMs: number;
  };
  wierdnessVerdict: WierdnessVerdict;
};

export class WierdnessEnlinement {
  /**
   * Introduces controlled, organic audio anomalies, pitch drift, and spectral
   * saturation to eliminate sterile digital precision and inject raw character.
   */
  static enlineWierdness(ctx: ExecutionContext, input: WierdnessInput): WierdnessBlueprint {
    const wierdnessBlueprintId = `wierdness_${ctx.sessionNonce}_${Date.now()}`;
    const chaos = clamp01(input.chaosFactor);
    const targetElement = input.targetElement || "MASTER_BUS";

    // Element bias: vocals stay slightly more restrained; master bus opens widest.
    const elementScale =
      targetElement === "VOCAL_LAYERS"
        ? 0.85
        : targetElement === "GUITAR_TRANSIENTS"
          ? 1.05
          : targetElement === "SYNTH_PADS"
            ? 1.0
            : 1.1;
    const scaled = clamp01(chaos * elementScale);

    const microPitchDetuneCents = Number((scaled * 12.5).toFixed(2));
    const tapeWobbleDepth = Number((scaled * 0.35).toFixed(3));
    const spectralSaturationDrive = Number((scaled * 4.2).toFixed(2));
    const granularScatterSpreadMs = Number((scaled * 45).toFixed(1));

    let verdict: WierdnessVerdict = "SUBTLE_CHARACTER";
    if (scaled > 0.7) {
      verdict = "RADICAL_ALTERATION";
    } else if (scaled > 0.35) {
      verdict = "EXPERIMENTAL_DRIFT";
    }

    return {
      wierdnessBlueprintId,
      appliedChaosFactor: Number(scaled.toFixed(4)),
      targetElement,
      anomalyParameters: {
        microPitchDetuneCents,
        tapeWobbleDepth,
        spectralSaturationDrive,
        granularScatterSpreadMs,
      },
      wierdnessVerdict: verdict,
    };
  }

  /**
   * Resolve chaos factor from studio weirdness (0–100), acoustic drift, or organic drift.
   */
  static resolveChaosFactor(input: {
    weirdness?: unknown;
    chaosDrift?: unknown;
    organicDrift?: unknown;
    acousticChaosDrift?: unknown;
  }): number {
    if (typeof input.weirdness === "number" && Number.isFinite(input.weirdness)) {
      // Studio control is typically 0–100.
      return clamp01(input.weirdness > 1.5 ? input.weirdness / 100 : input.weirdness);
    }
    if (typeof input.weirdness === "string") {
      const n = Number.parseFloat(input.weirdness);
      if (Number.isFinite(n)) {
        return clamp01(n > 1.5 ? n / 100 : n);
      }
    }
    const driftCandidates = [
      input.acousticChaosDrift,
      input.chaosDrift,
      input.organicDrift,
    ];
    for (const d of driftCandidates) {
      if (typeof d === "number" && Number.isFinite(d)) {
        // Organic drift is often ±0.05 — map absolute magnitude into a usable chaos band.
        return clamp01(Math.abs(d) * 8);
      }
    }
    return 0.25;
  }

  static resolveTargetElement(input: {
    instrumental?: boolean;
    hasVocal?: boolean;
    genreHint?: unknown;
  }): WierdnessTargetElement {
    const genre = String(input.genreHint ?? "").toLowerCase();
    if (/metal|rock|guitar/.test(genre)) return "GUITAR_TRANSIENTS";
    if (/synth|electronic|amapiano|pad/.test(genre)) return "SYNTH_PADS";
    if (input.hasVocal && !input.instrumental) return "VOCAL_LAYERS";
    return "MASTER_BUS";
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
