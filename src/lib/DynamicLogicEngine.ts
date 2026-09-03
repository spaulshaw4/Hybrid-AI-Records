/**
 * Dynamic Logic Engine — live adaptive throttles & intensity scaling.
 *
 * Queue depth uses stepped backoff (empty / normal / congested) so worker
 * drain stays predictable; empty-queue polling still uses the intuition curve.
 */

import { FormulaBasedIntuition } from "@/lib/FormulaBasedIntuition";

export class DynamicLogicEngine {
  /**
   * Dynamically calculates worker poll throttle intervals based on live queue congestion.
   */
  static calculateAdaptiveThrottle(
    pendingJobCount: number,
    baseThrottleMs = 3000,
    behavioralMultiplier = 1,
  ): number {
    const pending = Math.max(0, Math.trunc(pendingJobCount || 0));
    const base = Math.max(0, baseThrottleMs);
    const mult = Number.isFinite(behavioralMultiplier)
      ? Math.min(3, Math.max(0.75, behavioralMultiplier))
      : 1;

    FormulaBasedIntuition.computeIntuitiveBackoff(pending, base || 3000);

    let next = base;
    if (pending < 5) {
      next = Math.max(base / 2, 1_000);
    } else if (pending >= 100) {
      next = Math.min(base * 2, 10_000);
    }

    return Math.round(Math.min(15_000, next * mult));
  }

  /**
   * Queue load factor 0..1+ from pending depth (soft cap for pressure math).
   */
  static queueLoadFactor(pendingJobCount: number, softCap = 50): number {
    const pending = Math.max(0, pendingJobCount || 0);
    const cap = Math.max(1, softCap);
    return pending / cap;
  }

  /**
   * Dynamically modulates generation temperature when queue pressure is high.
   * Load at or above 0.8 drops temperature by 0.05.
   */
  static applyDynamicScaling(baseTemperature: number, queueLoadFactor: number) {
    const load = Math.max(0, queueLoadFactor || 0);
    const dynamicScalingApplied = load >= 0.8;
    const pressureAdjustment = dynamicScalingApplied ? -0.05 : 0;
    return {
      adjustedTemperature: Math.max(0.1, Math.min(1.0, baseTemperature + pressureAdjustment)),
      dynamicScalingApplied,
      queueLoadFactor: load,
      pressureAdjustment,
    };
  }

  /**
   * Adaptive empty-queue poll interval (sister of upstream throttle).
   */
  static calculateAdaptivePoll(pendingJobCount: number, basePollMs = 2500): number {
    return FormulaBasedIntuition.computeIntuitivePoll(pendingJobCount, basePollMs);
  }
}
