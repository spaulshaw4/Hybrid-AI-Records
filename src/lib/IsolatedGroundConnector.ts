/**
 * Isolated Ground Connector — divert contaminated / faulted streams off the hot path.
 *
 * Grounds quarantine breaches, detanglement failures, and execution spikes into
 * Informant quarantine telemetry so End-Gate refunds can proceed without
 * poisoning worker memory or cluster state.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { TelemetryAlignment } from "@/lib/TelemetryAlignment";

export type GroundFaultSource =
  | "QUARANTINE_NODE"
  | "DETANGLEMENT_BREACH"
  | "PIPELINE_TIMEOUT"
  | "UNKNOWN_SPIKE";

export type GroundFaultPayload = {
  errorCode: string;
  faultSource: GroundFaultSource;
  rawContaminatedData: unknown;
  drainNonce: string;
};

export type GroundedFaultResult = {
  status: "GROUNDED_FAULT";
  groundDrainReference: string;
  errorHandled: true;
  message: string;
  faultSource: GroundFaultSource;
  errorCode: string;
};

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

export class IsolatedGroundConnector {
  /**
   * Safely routes contaminated or faulted execution streams away from the
   * active hot path and grounds them into an isolated quarantine drain.
   */
  static async drainFaultToGround(
    ctx: ExecutionContext,
    fault: GroundFaultPayload,
  ): Promise<string> {
    const groundDrainId = `ground_drain_${ctx.sessionNonce}_${Date.now()}`;

    // 1. Isolate the fault data (zero reference backflow to active memory).
    const sanitizedFaultRecord = JSON.parse(
      JSON.stringify({
        groundDrainId,
        requestId: ctx.requestId,
        jobId: ctx.jobId ?? null,
        userId: ctx.userId,
        tier: ctx.tier,
        sourceGate: ctx.sourceGate,
        faultSource: fault.faultSource,
        errorCode: fault.errorCode,
        drainNonce: fault.drainNonce,
        contaminantDigest: digestContaminant(fault.rawContaminatedData),
        timestamp: new Date().toISOString(),
      }),
    ) as Record<string, unknown>;

    // 2. Persistent quarantine audit via aligned telemetry dialect.
    await TelemetryAlignment.recordEvent(ctx, {
      eventType: "ISOLATED_GROUND_DRAIN_TRIGGERED",
      status: "FAULT",
      details: {
        ...sanitizedFaultRecord,
        systemActor: SYSTEM_ACTOR,
      },
    });

    console.warn("[ISOLATED GROUND] fault drained", {
      groundDrainId,
      faultSource: fault.faultSource,
      errorCode: fault.errorCode,
      requestId: ctx.requestId,
      jobId: ctx.jobId ?? null,
    });

    // 3. Isolated ground reference for End-Gate / refund handlers.
    return groundDrainId;
  }

  /** Classify a thrown error into a ground fault source. */
  static classifyFaultSource(error: unknown): GroundFaultSource {
    const message =
      error instanceof Error ? error.message : typeof error === "string" ? error : "";
    if (/SECURITY HALT|QUARANTINE|deep isolation/i.test(message)) {
      return "QUARANTINE_NODE";
    }
    if (/entanglement|detanglement|cross-talk|cross talk/i.test(message)) {
      return "DETANGLEMENT_BREACH";
    }
    if (/timeout|etimedout|aborted|deadline/i.test(message)) {
      return "PIPELINE_TIMEOUT";
    }
    return "UNKNOWN_SPIKE";
  }
}

/**
 * Wrap an isolated-core execution fn so catastrophic faults divert to ground
 * instead of crashing the worker cluster path.
 */
export async function executeWithGroundProtection<T>(
  ctx: ExecutionContext,
  executionFn: () => Promise<T>,
): Promise<T | GroundedFaultResult> {
  try {
    return await executionFn();
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string; stack?: string };
    const faultSource = IsolatedGroundConnector.classifyFaultSource(error);
    const groundPayload: GroundFaultPayload = {
      errorCode: err?.code || "CORE_EXECUTION_FAULT",
      faultSource,
      rawContaminatedData: err?.stack || err?.message || String(error ?? "unknown"),
      drainNonce: `drain_${ctx.sessionNonce}`,
    };

    const drainReferenceId = await IsolatedGroundConnector.drainFaultToGround(
      ctx,
      groundPayload,
    );

    return {
      status: "GROUNDED_FAULT",
      groundDrainReference: drainReferenceId,
      errorHandled: true,
      message: "Execution fault successfully diverted to isolated ground.",
      faultSource,
      errorCode: groundPayload.errorCode,
    };
  }
}

function digestContaminant(raw: unknown): string {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : raw instanceof Error
          ? `${raw.name}: ${raw.message}`
          : JSON.stringify(raw);
    return String(text ?? "").slice(0, 800);
  } catch {
    return "[unserializable_contaminant]";
  }
}
