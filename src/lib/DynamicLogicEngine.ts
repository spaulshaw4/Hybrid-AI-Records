/**
 * Dynamic Logic Engine — live adaptive throttles & intensity scaling.
 *
 * Uses FormulaBasedIntuition continuous curves (log backoff / soft poll)
 * instead of hard step thresholds alone.
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

    // Continuous intuition curve first.
    const intuitive = FormulaBasedIntuition.computeIntuitiveBackoff(pending, base || 3000);

    // Consequence behavior: multiply backoff after failure spikes (or ease on stability).
    const mult = Number.isFinite(behavioralMultiplier)
      ? Math.min(3, Math.max(0.75, behavioralMultiplier))
      : 1;
    const adapted = Math.round(intuitive * mult);

    // Preserve legacy floor for near-empty queues.
    if (pending < 5) {
      return Math.min(adapted, Math.max((base / 2) * mult, 1_000));
    }
    return Math.min(adapted, 15_000);
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
   * Dynamically modulates generation parameters using live environmental pressure.
   * Soft sigmoid-ish pressure: scales smoothly past 0.5 load instead of a hard cliff at 0.8.
   */
  static applyDynamicScaling(baseTemperature: number, queueLoadFactor: number) {
    const load = Math.max(0, queueLoadFactor || 0);
    const pressure = 1 / (1 + Math.exp(-8 * (load - 0.75)));
    const pressureAdjustment = -0.05 * pressure;
    return {
      adjustedTemperature: Math.max(0.1, Math.min(1.0, baseTemperature + pressureAdjustment)),
      dynamicScalingApplied: pressureAdjustment < -0.001,
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
