/**
 * Probabilistic State-Space Fluctuator — logistic-map organic drift.
 *
 * Deterministic chaos seeded by ExecutionContext.requestId / sessionNonce.
 * Reproducible for audits, organic micro-variation across runs, zero I/O.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";

export type IntuitiveFluxCoat = {
  prompt: string;
  resolvedTemperature: number;
  resolvedStyleWeight?: number;
  stateNonce: string;
  intuitiveLogicApplied: true;
  chaoticSeed: number;
  organicDrift: number;
};

export class IntuitiveStateFluctuator {
  /**
   * Build a stable seed in (0,1) from CTX ids (hex substring or FNV fallback).
   */
  static seedFromContext(ctx: ExecutionContext): number {
    const hex = (ctx.requestId || "").replace(/-/g, "").slice(0, 8);
    let seed = Number.parseInt(hex, 16);
    if (!Number.isFinite(seed)) {
      seed = algorithmicHash32(`${ctx.requestId}|${ctx.sessionNonce}|${ctx.userId}`);
    }
    // Avoid 0 / 1 fixed points of the logistic map.
    let x = (seed >>> 0) / 0xffffffff;
    if (x <= 0 || x >= 1) x = 0.314159265;
    return x;
  }

  /**
   * Applies a non-linear chaotic map (logistic map) to derive organic drift.
   * x_{n+1} = r * x_n * (1 - x_n)
   */
  static computeIntuitiveDrift(ctx: ExecutionContext, baseValue: number, r = 3.85): number {
    let seed = IntuitiveStateFluctuator.seedFromContext(ctx);
    for (let i = 0; i < 5; i += 1) {
      seed = r * seed * (1 - seed);
    }
    const organicDrift = (seed - 0.5) * 0.1; // ≈ ±0.05
    return Number((baseValue + organicDrift).toFixed(4));
  }

  /**
   * Combines interpretive / algorithmic base params with chaotic state-space drift.
   */
  static fluxCoatWithIntuition(
    ctx: ExecutionContext,
    basePrompt: string,
    baseTemp: number,
    baseStyleWeight?: number,
  ): IntuitiveFluxCoat {
    let seed = IntuitiveStateFluctuator.seedFromContext(ctx);
    for (let i = 0; i < 5; i += 1) {
      seed = 3.85 * seed * (1 - seed);
    }
    const organicDrift = (seed - 0.5) * 0.1;
    const chaoticTemperature = Number((baseTemp + organicDrift).toFixed(4));

    let resolvedStyleWeight: number | undefined;
    if (typeof baseStyleWeight === "number" && Number.isFinite(baseStyleWeight)) {
      // Slightly smaller amplitude on style so intent stays dominant.
      resolvedStyleWeight = Number(
        Math.max(0.4, Math.min(1, baseStyleWeight + organicDrift * 0.5)).toFixed(4),
      );
    }

    return {
      prompt: (basePrompt ?? "").trim(),
      resolvedTemperature: Math.max(0.1, Math.min(1.0, chaoticTemperature)),
      resolvedStyleWeight,
      stateNonce: ctx.sessionNonce,
      intuitiveLogicApplied: true,
      chaoticSeed: Number(seed.toFixed(6)),
      organicDrift: Number(organicDrift.toFixed(4)),
    };
  }
}
