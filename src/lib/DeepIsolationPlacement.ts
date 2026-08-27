/**
 * Deep Isolation Core Placement — detangle, saturate-check, place, audit.
 *
 * Runs the Detanglement Reactor, evaluates isolation integrity + node load,
 * then returns a PlacementEnvelope the worker uses before Fluctuator.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import {
  DetanglementReactor,
  type ReactorCoreState,
} from "@/lib/DetanglementReactor";
import { TelemetryAlignment } from "@/lib/TelemetryAlignment";

export type IsolationSecurityVerdict =
  | "PASSED_ISOLATION"
  | "QUARANTINED"
  | "FALLBACK_ROUTED";

export type PlacementEnvelope = {
  targetClusterNode: string;
  isolationLevel: string;
  reactorNonce: string;
  sanitizedPayload: Record<string, unknown>;
  securityVerdict: IsolationSecurityVerdict;
  reactorState: ReactorCoreState;
};

export type SecureCoreDispatch = {
  node: string;
  payload: Record<string, unknown>;
  nonce: string;
  isolationLevel: string;
  securityVerdict: IsolationSecurityVerdict;
  reactorState: ReactorCoreState;
};

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** Entanglement fraction above which the payload is quarantined (reactor reports ~0–0.1). */
function entanglementCeiling(): number {
  return Math.max(
    0.01,
    Number.parseFloat(process.env.DEEP_ISOLATION_ENTANGLEMENT_CEILING ?? "0.08") || 0.08,
  );
}

function maxNodeCapacity(): number {
  return Math.max(1, Number.parseInt(process.env.MAX_NODE_CAPACITY ?? "25", 10) || 25);
}

export class DeepIsolationPlacement {
  /**
   * Executes deep isolation processing, evaluates node saturation,
   * and computes the secure core placement destination with audit telemetry.
   */
  static async routeAndPlace(
    ctx: ExecutionContext,
    rawPayload: Record<string, unknown>,
  ): Promise<PlacementEnvelope> {
    // 1. Pass payload through the deep isolation detanglement reactor.
    const { sanitizedPayload, reactorState } = DetanglementReactor.purgeCrossCorrelations(
      ctx,
      rawPayload,
    );

    // 2. Evaluate isolation integrity based on reactor metrics.
    const isCompromised =
      reactorState.entanglementLevel > entanglementCeiling() ||
      !reactorState.suppressionActive;

    if (isCompromised) {
      await DeepIsolationPlacement.logPlacementTelemetry(
        ctx,
        "QUARANTINED",
        "quarantine-isolation-node",
        reactorState,
      );
      return {
        targetClusterNode: "quarantine-isolation-node",
        isolationLevel: "MAXIMUM_SECURITY_STRIPPED",
        reactorNonce: reactorState.reactorNonce,
        sanitizedPayload: { error: "Payload failed deep isolation verification" },
        securityVerdict: "QUARANTINED",
        reactorState,
      };
    }

    // 3. Determine target node based on user tier.
    let targetNode =
      ctx.tier === "enterprise"
        ? "enterprise-isolated-grid-01"
        : "standard-worker-grid-pool";

    // 4. Edge-case safeguard: primary node cluster congestion → standby overflow.
    const isSaturated = await DeepIsolationPlacement.checkNodeSaturation(targetNode);
    if (isSaturated) {
      targetNode = "standby-overflow-grid-pool";
      await DeepIsolationPlacement.logPlacementTelemetry(
        ctx,
        "FALLBACK_ROUTED",
        targetNode,
        reactorState,
      );
      return {
        targetClusterNode: targetNode,
        isolationLevel: "ORTHOGONAL_SUPPRESSED_FALLBACK",
        reactorNonce: reactorState.reactorNonce,
        sanitizedPayload,
        securityVerdict: "FALLBACK_ROUTED",
        reactorState,
      };
    }

    // 5. Normal successful placement.
    await DeepIsolationPlacement.logPlacementTelemetry(
      ctx,
      "PASSED_ISOLATION",
      targetNode,
      reactorState,
    );
    return {
      targetClusterNode: targetNode,
      isolationLevel: "ORTHOGONAL_SUPPRESSED",
      reactorNonce: reactorState.reactorNonce,
      sanitizedPayload,
      securityVerdict: "PASSED_ISOLATION",
      reactorState,
    };
  }

  /**
   * Evaluates active node load against threshold constraints.
   */
  private static async checkNodeSaturation(nodeName: string): Promise<boolean> {
    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return false;

      const { count: activeJobs, error } = await admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "processing")
        .eq("assigned_node", nodeName);

      if (error) {
        console.warn("[DEEP ISOLATION] saturation probe failed", error.message);
        return false;
      }

      return (activeJobs ?? 0) >= maxNodeCapacity();
    } catch (err) {
      console.warn(
        "[DEEP ISOLATION] saturation probe failed",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /**
   * Writes placement telemetry audit records via Informant (never throws).
   */
  private static async logPlacementTelemetry(
    ctx: ExecutionContext,
    verdict: IsolationSecurityVerdict,
    node: string,
    reactor: ReactorCoreState,
  ): Promise<void> {
    const status =
      verdict === "QUARANTINED"
        ? "QUARANTINED"
        : verdict === "FALLBACK_ROUTED"
          ? "WARNING"
          : "SUCCESS";

    await TelemetryAlignment.recordEvent(ctx, {
      eventType: "DEEP_ISOLATION_PLACEMENT",
      status,
      details: {
        securityVerdict: verdict,
        targetNode: node,
        entanglementLevel: reactor.entanglementLevel,
        entropyScore: reactor.entropyScore,
        reactorNonce: reactor.reactorNonce,
        suppressionActive: reactor.suppressionActive,
        maxNodeCapacity: maxNodeCapacity(),
        systemActor: SYSTEM_ACTOR,
      },
    });
  }
}

/**
 * Worker dispatcher helper: deep-isolate, halt on quarantine, else return
 * the assigned secure cluster node + sanitized payload (including fallback).
 */
export async function dispatchToSecureCore(
  ctx: ExecutionContext,
  rawJobPayload: Record<string, unknown>,
): Promise<SecureCoreDispatch> {
  const placement = await DeepIsolationPlacement.routeAndPlace(ctx, rawJobPayload);

  if (placement.securityVerdict === "QUARANTINED") {
    throw new Error(
      `[SECURITY HALT] Payload quarantined at node ${placement.targetClusterNode} (Nonce: ${placement.reactorNonce})`,
    );
  }

  return {
    node: placement.targetClusterNode,
    payload: placement.sanitizedPayload,
    nonce: placement.reactorNonce,
    isolationLevel: placement.isolationLevel,
    securityVerdict: placement.securityVerdict,
    reactorState: placement.reactorState,
  };
}
