/**
 * ActuatorMonitor — pure threshold logic for queue health.
 *
 * No AI diagnostics. Evaluates pending / processing / failed counts in
 * microseconds and returns a deterministic recommended operational action.
 */

import { FormulaBasedIntuition } from "@/lib/FormulaBasedIntuition";

export type SystemMetrics = {
  pendingJobs: number;
  processingJobs: number;
  failedJobCount: number;
};

export type ActuatorHealthStatus = "OPTIMAL" | "CONGESTED" | "CRITICAL";

export type ActuatorRecommendedAction =
  | "NONE"
  | "SCALE_THROTTLE_WINDOW"
  | "TRIGGER_CIRCUIT_BREAKER_AND_ALERT"
  | "DRAIN_PROCESSING_BACKLOG";

export type ActuatorEvaluation = {
  status: ActuatorHealthStatus;
  metricsSnapshot: {
    pending: number;
    processing: number;
    failed: number;
  };
  recommendedAction: ActuatorRecommendedAction;
  evaluatedAt: string;
};

/** Tunables — override via env without code changes. */
export const ACTUATOR_FAILED_CRITICAL = Math.max(
  1,
  Number.parseInt(process.env.ACTUATOR_FAILED_CRITICAL ?? "15", 10) || 15,
);
export const ACTUATOR_PENDING_CONGESTED = Math.max(
  1,
  Number.parseInt(process.env.ACTUATOR_PENDING_CONGESTED ?? "50", 10) || 50,
);
export const ACTUATOR_PROCESSING_BACKLOG = Math.max(
  1,
  Number.parseInt(process.env.ACTUATOR_PROCESSING_BACKLOG ?? "25", 10) || 25,
);

export class ActuatorMonitor {
  /**
   * Evaluates system health metrics deterministically in real time.
   * Uses FormulaBasedIntuition PID pressure to pre-trip on failure acceleration.
   */
  static evaluateHealth(metrics: SystemMetrics): ActuatorEvaluation {
    const pending = Math.max(0, Math.trunc(metrics.pendingJobs || 0));
    const processing = Math.max(0, Math.trunc(metrics.processingJobs || 0));
    const failed = Math.max(0, Math.trunc(metrics.failedJobCount || 0));

    const pid = FormulaBasedIntuition.computeFailurePressure(
      failed,
      ACTUATOR_FAILED_CRITICAL,
    );

    let status: ActuatorHealthStatus = "OPTIMAL";
    let action: ActuatorRecommendedAction = "NONE";

    if (failed > ACTUATOR_FAILED_CRITICAL || pid.shouldPreTrip) {
      status = "CRITICAL";
      action = "TRIGGER_CIRCUIT_BREAKER_AND_ALERT";
    } else if (pending > ACTUATOR_PENDING_CONGESTED) {
      status = "CONGESTED";
      action = "SCALE_THROTTLE_WINDOW";
    } else if (processing > ACTUATOR_PROCESSING_BACKLOG) {
      status = "CONGESTED";
      action = "DRAIN_PROCESSING_BACKLOG";
    } else if (pid.pressure > 0.75) {
      // Rising failure pressure — congested advisory before hard trip.
      status = "CONGESTED";
      action = "SCALE_THROTTLE_WINDOW";
    }

    return {
      status,
      metricsSnapshot: { pending, processing, failed },
      recommendedAction: action,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
