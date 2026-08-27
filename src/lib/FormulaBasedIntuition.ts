/**
 * Formula-Based Intuition — continuous mathematical heuristics.
 *
 * Replaces binary step-functions with sigmoid, logarithmic, and PID curves
 * so throttle / temperature / breaker decisions feel human-tuned, not abrupt.
 */

export class FormulaBasedIntuition {
  /** Prior failure sample for derivative (PID) — process-local, zero I/O. */
  private static lastFailedCount = 0;
  private static lastFailedAt = 0;
  private static integralError = 0;

  /**
   * Sigmoid curve mapping for smooth, continuous temperature scaling.
   * Temperature = Tmin + (Tmax-Tmin) / (1 + e^{-k (complexity - x0)})
   */
  static computeIntuitiveTemperature(complexityScore: number, baseTemp = 0.72): number {
    const k = 0.1;
    const midpoint = 50;
    const score = Number.isFinite(complexityScore) ? complexityScore : midpoint;
    const sigmoid = 1 / (1 + Math.exp(-k * (score - midpoint)));
    // Blend base tier temp with sigmoid band 0.65..0.90
    const curved = 0.65 + sigmoid * 0.25;
    // Tier baseline retains majority weight so pro/free stay distinct after intuition.
    const blended = baseTemp * 0.6 + curved * 0.4;
    return Number(clamp(blended, 0.55, 1.05).toFixed(3));
  }

  /**
   * Continuous worker backoff from load pressure (log curve, not hard steps).
   */
  static computeIntuitiveBackoff(pendingCount: number, baseMs = 3000): number {
    const pending = Math.max(0, pendingCount || 0);
    const base = Math.max(500, baseMs);
    const loadFactor = Math.log1p(pending);
    return Math.min(Math.round(base * (1 + loadFactor * 0.5)), 12_000);
  }

  /**
   * Soft speed-up when the queue is nearly empty (inverse of backoff).
   */
  static computeIntuitivePoll(pendingCount: number, basePollMs = 2500): number {
    const pending = Math.max(0, Math.trunc(pendingCount || 0));
    const base = Math.max(500, basePollMs);
    if (pending === 0) return base;
    // Gentle acceleration as backlog appears but stays small
    const urgency = 1 / (1 + Math.exp(-0.35 * (pending - 3)));
    return Math.max(250, Math.round(base * (1 - 0.55 * urgency)));
  }

  /**
   * Non-linear micro-variation from FNV entropy (sin/log) — feels human-tuned.
   * Returns a small delta in [-amp, +amp].
   */
  static hashMicroVariation(entropy: number, amplitude = 0.008): number {
    const u = (entropy >>> 0) / 0xffffffff;
    const wave = Math.sin(u * Math.PI * 2) * 0.6 + Math.log1p(u) * 0.4;
    return clamp(wave * amplitude, -amplitude, amplitude);
  }

  /**
   * PID-style failure pressure: P on level, I on sustained error, D on acceleration.
   * Returns trip recommendation strength 0..1 (caller decides HARD trip threshold).
   */
  static computeFailurePressure(
    failedCount: number,
    criticalThreshold = 15,
  ): {
    pressure: number;
    derivative: number;
    shouldPreTrip: boolean;
  } {
    const failed = Math.max(0, Math.trunc(failedCount || 0));
    const now = Date.now();
    const dtSec = Math.max(0.001, (now - (this.lastFailedAt || now)) / 1000);

    const error = failed - criticalThreshold * 0.6; // start reacting before hard ceiling
    const derivative = (failed - this.lastFailedCount) / dtSec;

    this.integralError = clamp(this.integralError + error * dtSec, -50, 50);
    this.lastFailedCount = failed;
    this.lastFailedAt = now;

    const Kp = 0.08;
    const Ki = 0.01;
    const Kd = 0.15;
    const raw = Kp * error + Ki * this.integralError + Kd * derivative;
    const pressure = clamp(1 / (1 + Math.exp(-raw)), 0, 1);

    // Pre-trip when failures are accelerating hard even if below absolute count.
    const shouldPreTrip =
      failed >= criticalThreshold || (failed >= Math.ceil(criticalThreshold * 0.7) && derivative > 2);

    return { pressure, derivative, shouldPreTrip };
  }

  /** Test helper — reset PID memory. */
  static resetPidState(): void {
    this.lastFailedCount = 0;
    this.lastFailedAt = 0;
    this.integralError = 0;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
