/**
 * Pipeline Trigger Orchestrator — Actuator feedback loops that fire real actions.
 *
 * Delegates concrete enforcement to PipelineAutomationEngine so Sentinel,
 * Actuator health checks, and threshold monitors share one trip path.
 */

import { ActuatorMonitor, type SystemMetrics } from "@/lib/ActuatorMonitor";
import { PipelineAutomationEngine } from "@/lib/PipelineAutomationEngine";

export type SafeguardResult =
  | {
      tripped: true;
      actionTaken: "MAINTENANCE_ENGAGED";
      status: "CRITICAL";
      metricsSnapshot: SystemMetrics;
    }
  | {
      tripped: false;
      status: "OPTIMAL" | "CONGESTED" | "CRITICAL";
      recommendedAction: string;
    };

export class PipelineTriggerOrchestrator {
  /**
   * Evaluates pre-fetched metrics against trigger points and enforces
   * MAINTENANCE via PipelineAutomationEngine when CRITICAL.
   */
  static async evaluateAndTriggerSafeguards(metrics: SystemMetrics): Promise<SafeguardResult> {
    const healthReport = ActuatorMonitor.evaluateHealth(metrics);

    if (healthReport.status !== "CRITICAL") {
      return {
        tripped: false,
        status: healthReport.status,
        recommendedAction: healthReport.recommendedAction,
      };
    }

    const engaged = await PipelineAutomationEngine.engageMaintenanceMode({
      pending: healthReport.metricsSnapshot.pending,
      processing: healthReport.metricsSnapshot.processing,
      failed: healthReport.metricsSnapshot.failed,
      criticalThreshold: Number.parseInt(
        process.env.ACTUATOR_FAILED_CRITICAL || "15",
        10,
      ) || 15,
      recommendedAction: healthReport.recommendedAction,
    });

    if (!engaged) {
      return {
        tripped: false,
        status: "CRITICAL",
        recommendedAction: healthReport.recommendedAction,
      };
    }

    return {
      tripped: true,
      actionTaken: "MAINTENANCE_ENGAGED",
      status: "CRITICAL",
      metricsSnapshot: {
        pendingJobs: healthReport.metricsSnapshot.pending,
        processingJobs: healthReport.metricsSnapshot.processing,
        failedJobCount: healthReport.metricsSnapshot.failed,
      },
    };
  }
}
