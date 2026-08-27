/**
 * Pipeline Automation Engine — concrete autonomous health & maintenance loop.
 *
 * Executed by the Sentinel Bot and Actuator checkpoints. Reads live queue
 * metrics, applies threshold logic, and trips the Activator Switch when
 * failure volume breaches ACTUATOR_FAILED_CRITICAL (default 15).
 */

import { ACTUATOR_FAILED_CRITICAL, ActuatorMonitor } from "@/lib/ActuatorMonitor";
import { PipelineActivatorSwitch } from "@/lib/PipelineActivatorSwitch";
import { PipelineInformant } from "@/lib/PipelineInformant";

export type AutomationEngineResult =
  | {
      status: "TRIPPED";
      action: "MAINTENANCE_ENGAGED";
      pending: number;
      processing: number;
      failed: number;
      criticalThreshold: number;
    }
  | {
      status: "HEALTHY" | "CONGESTED" | "CRITICAL" | "DEGRADED";
      pending: number;
      processing: number;
      failed: number;
      criticalThreshold: number;
      recommendedAction?: string;
      tripped: false;
    };

function autoTripEnabled(): boolean {
  const v = process.env.ACTUATOR_AUTO_TRIP;
  if (v === "0" || v === "false" || v === "off") return false;
  return true;
}

export class PipelineAutomationEngine {
  /**
   * Concrete Logic: The Autonomous Health & Maintenance Loop.
   * Reads live metrics from the durable queue and enforces MAINTENANCE on breach.
   */
  static async evaluateAndEnforceSystemState(): Promise<AutomationEngineResult> {
    const criticalThreshold = ACTUATOR_FAILED_CRITICAL;

    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (!admin) {
      return {
        status: "DEGRADED",
        pending: 0,
        processing: 0,
        failed: 0,
        criticalThreshold,
        recommendedAction: "NONE",
        tripped: false,
      };
    }

    // 1. Read live metrics from generation_queue.
    const [
      { count: pendingJobs, error: pendingError },
      { count: processingJobs, error: processingError },
      { count: failedJobs, error: failedError },
    ] = await Promise.all([
      admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending"),
      admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "processing"),
      admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "failed"),
    ]);

    if (pendingError || processingError || failedError) {
      console.error(
        "[AUTOMATION] metric probe failed",
        pendingError?.message || processingError?.message || failedError?.message,
      );
      return {
        status: "DEGRADED",
        pending: pendingJobs ?? 0,
        processing: processingJobs ?? 0,
        failed: failedJobs ?? 0,
        criticalThreshold,
        recommendedAction: "NONE",
        tripped: false,
      };
    }

    const pending = pendingJobs ?? 0;
    const processing = processingJobs ?? 0;
    const failed = failedJobs ?? 0;

    // 2. Threshold trigger logic (Actuator decision surface).
    const healthReport = ActuatorMonitor.evaluateHealth({
      pendingJobs: pending,
      processingJobs: processing,
      failedJobCount: failed,
    });

    if (failed > criticalThreshold || healthReport.status === "CRITICAL") {
      console.warn(
        `[CRITICAL THRESHOLD BREACH] Failed jobs count (${failed}) exceeded limit (${criticalThreshold}).`,
      );

      if (!autoTripEnabled()) {
        return {
          status: "CRITICAL",
          pending,
          processing,
          failed,
          criticalThreshold,
          recommendedAction: healthReport.recommendedAction,
          tripped: false,
        };
      }

      // 3. Automated action: trip Activator Switch → MAINTENANCE (keeps cache coherent).
      const tripped = await PipelineAutomationEngine.engageMaintenanceMode({
        pending,
        processing,
        failed,
        criticalThreshold,
        recommendedAction: healthReport.recommendedAction,
      });

      if (tripped) {
        return {
          status: "TRIPPED",
          action: "MAINTENANCE_ENGAGED",
          pending,
          processing,
          failed,
          criticalThreshold,
        };
      }

      return {
        status: "CRITICAL",
        pending,
        processing,
        failed,
        criticalThreshold,
        recommendedAction: healthReport.recommendedAction,
        tripped: false,
      };
    }

    return {
      status: healthReport.status === "OPTIMAL" ? "HEALTHY" : healthReport.status,
      pending,
      processing,
      failed,
      criticalThreshold,
      recommendedAction: healthReport.recommendedAction,
      tripped: false,
    };
  }

  /**
   * Engage MAINTENANCE via Activator Switch + Informant CIRCUIT_BREAKER_TRIP.
   * Used by AutomationEngine and TriggerOrchestrator.
   */
  static async engageMaintenanceMode(input: {
    pending: number;
    processing: number;
    failed: number;
    criticalThreshold: number;
    recommendedAction?: string;
  }): Promise<boolean> {
    const secret = process.env.ADMIN_ACTUATOR_SECRET?.trim();

    if (secret) {
      try {
        await PipelineActivatorSwitch.setSystemState("MAINTENANCE", secret);
      } catch (err) {
        console.error(
          "[AUTOMATION] setSystemState failed",
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    } else {
      console.error(
        "[AUTOMATION] CRITICAL breach but ADMIN_ACTUATOR_SECRET is unset — attempting direct system_config upsert.",
      );
      try {
        const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
        const admin = tryGetSupabaseAdmin();
        if (!admin) return false;
        const { error } = await admin.from("system_config").upsert(
          {
            key: "pipeline_master_state",
            value: "MAINTENANCE",
            updated_at: new Date().toISOString(),
            updated_by: "pipeline-automation-engine",
          },
          { onConflict: "key" },
        );
        if (error) {
          console.error("[AUTOMATION] emergency upsert failed", error.message);
          return false;
        }
        PipelineActivatorSwitch.bustCache();
      } catch (err) {
        console.error(
          "[AUTOMATION] emergency upsert failed",
          err instanceof Error ? err.message : err,
        );
        return false;
      }
    }

    // Telemetry audit (null user_id — system-level, UUID-safe).
    await PipelineInformant.recordTelemetry({
      eventType: "CIRCUIT_BREAKER_TRIP",
      userId: null,
      metadata: {
        reason: "Automated trip due to high failure volume",
        failedCount: input.failed,
        pendingCount: input.pending,
        processingCount: input.processing,
        criticalThreshold: input.criticalThreshold,
        recommendedAction: input.recommendedAction ?? "TRIGGER_CIRCUIT_BREAKER_AND_ALERT",
        systemActor: "00000000-0000-0000-0000-000000000000",
        source: "pipeline-automation-engine",
      },
    });

    return true;
  }
}
