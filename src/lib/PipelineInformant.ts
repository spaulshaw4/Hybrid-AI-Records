/**
 * Pipeline Informant — structured telemetry for the generation closed loop.
 *
 * Records queue performance, token burns/refunds, and failure rates without
 * ever crashing the core Cortex → Worker → End-Gate path.
 */

import type { Json } from "@/integrations/supabase/types";

export type TelemetryEventType =
  | "QUEUE_ENQUEUE"
  | "WORKER_START"
  | "GENERATION_SUCCESS"
  | "GENERATION_FAILURE"
  | "TOKEN_REFUND"
  | "ACTUATOR_FLUSH"
  | "ACTUATOR_HEALTH"
  | "QUEUE_PENDING"
  | "QUEUE_PROCESSING"
  | "QUEUE_COMPLETED"
  | "QUEUE_FAILED"
  | "CIRCUIT_BREAKER_TRIP"
  | "CONSEQUENCE_FAILURE_ADAPTATION"
  | "REACTIVE_PLACEMENT_ROUTING"
  | "DEEP_ISOLATION_PLACEMENT"
  | "ISOLATED_GROUND_DRAIN_TRIGGERED"
  | "LEDGER_SETTLEMENT_COMMITTED"
  | "PREFLIGHT_EVALUATION"
  | "BINARY_SUPPRESSION_APPLIED"
  | "DETANGLEMENT_REACTOR_CHECK"
  | "CHAOTIC_FLUCTUATION_APPLIED"
  | "DISPATCH_ALIGNED";

export type TelemetryEvent = {
  eventType: TelemetryEventType;
  jobId?: string | null;
  /** May be omitted for system-level Actuator events. */
  userId?: string | null;
  metadata?: Record<string, unknown>;
};

export class PipelineInformant {
  /**
   * Logs pipeline telemetry and system events for audit trails and monitoring.
   * Never throws to callers — Informant failure must not crash the pipeline.
   */
  static async recordTelemetry(event: TelemetryEvent): Promise<void> {
    try {
      const userLabel = event.userId?.trim() || "system";
      console.log(
        `[INFORMANT TELEMETRY] [${event.eventType}] User: ${userLabel}`,
        JSON.stringify(event.metadata ?? {}),
      );

      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return;

      const { error } = await admin.from("pipeline_telemetry_logs").insert({
        event_type: event.eventType,
        job_id: event.jobId?.trim() || null,
        user_id: event.userId?.trim() || null,
        metadata: (event.metadata ?? {}) as Json,
        created_at: new Date().toISOString(),
      });


      if (error) {
        console.error("Informant telemetry write failed:", error.message);
      }
    } catch (err) {
      console.error(
        "Informant telemetry write failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Fire-and-forget wrapper so hot paths stay non-blocking. */
  static emit(event: TelemetryEvent): void {
    void PipelineInformant.recordTelemetry(event);
  }
}
