/**
 * Telemetry Alignment — uniform audit dialect across every pipeline stage.
 *
 * All critical junctures emit the same envelope (requestId, sessionNonce, tier,
 * status, details) via PipelineInformant so hot paths stay non-blocking.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { PipelineInformant, type TelemetryEventType } from "@/lib/PipelineInformant";

export type PipelineEventType =
  | "PREFLIGHT_EVALUATION"
  | "BINARY_SUPPRESSION_APPLIED"
  | "DETANGLEMENT_REACTOR_CHECK"
  | "DEEP_ISOLATION_PLACEMENT"
  | "CHAOTIC_FLUCTUATION_APPLIED"
  | "DISPATCH_ALIGNED"
  | "LEDGER_SETTLEMENT_COMMITTED"
  | "ISOLATED_GROUND_DRAIN_TRIGGERED";

export type AlignedTelemetryStatus = "SUCCESS" | "WARNING" | "QUARANTINED" | "FAULT";

export type AlignedTelemetryPayload = {
  eventType: PipelineEventType;
  status: AlignedTelemetryStatus;
  details?: Record<string, unknown>;
};

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

export class TelemetryAlignment {
  /**
   * Emits a standardized telemetry record ensuring every pipeline stage
   * speaks the same data dialect. Never throws — fire-and-forget safe.
   */
  static async recordEvent(
    ctx: ExecutionContext,
    payload: AlignedTelemetryPayload,
  ): Promise<void> {
    const userId =
      ctx.userId && ctx.userId !== "system" ? ctx.userId : SYSTEM_ACTOR;

    await PipelineInformant.recordTelemetry({
      eventType: payload.eventType as TelemetryEventType,
      jobId: ctx.jobId ?? null,
      userId,
      metadata: {
        requestId: ctx.requestId,
        sessionNonce: ctx.sessionNonce,
        tier: ctx.tier,
        sourceGate: ctx.sourceGate,
        status: payload.status,
        timestamp: new Date().toISOString(),
        ...(payload.details ?? {}),
      },
    });
  }

  /** Non-blocking hot-path emit. */
  static emit(ctx: ExecutionContext, payload: AlignedTelemetryPayload): void {
    void TelemetryAlignment.recordEvent(ctx, payload);
  }
}

/** Detanglement / quarantine checkpoint helper. */
export async function logReactorCheckpoint(
  ctx: ExecutionContext,
  entanglementLevel: number,
  quarantined: boolean,
): Promise<void> {
  await TelemetryAlignment.recordEvent(ctx, {
    eventType: "DETANGLEMENT_REACTOR_CHECK",
    status: quarantined ? "QUARANTINED" : "SUCCESS",
    details: {
      entanglementLevel,
      action: quarantined ? "STRIPPED_VECTORS" : "PASSED_ORTHOGONAL",
    },
  });
}
