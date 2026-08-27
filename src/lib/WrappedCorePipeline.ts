/**
 * Wrapped Core Pipeline — sealed end-to-end pre-execution path.
 *
 * Composes perimeter defense → entanglement suppression → deep isolation
 * placement → intuitive / CTX fluctuation into one immutable runner.
 * Provider dispatch + End-Gate remain the caller's responsibility.
 * Catastrophic faults divert through the Isolated Ground Connector.
 */

import type { ExecutionTier } from "@/lib/ExecutionContext";
import { ContextFactory, type ExecutionContext } from "@/lib/ExecutionContext";
import { ProactiveFlowEnforcer } from "@/lib/ProactiveFlowEnforcer";
import { BinaryEntanglementSuppressor } from "@/lib/BinaryEntanglementSuppressor";
import { DeepIsolationPlacement, type PlacementEnvelope } from "@/lib/DeepIsolationPlacement";
import { IntuitiveStateFluctuator, type IntuitiveFluxCoat } from "@/lib/IntuitiveStateFluctuator";
import { CtxFluctuatorEngine, type ModulatedOutput } from "@/lib/CtxFluctuatorEngine";
import {
  executeWithGroundProtection,
  type GroundedFaultResult,
} from "@/lib/IsolatedGroundConnector";

export type SealedPipelineResult = {
  status: "SEALED_AND_EXECUTING";
  assignedNode: string;
  isolationNonce: string;
  isolationLevel: string;
  securityVerdict: PlacementEnvelope["securityVerdict"];
  executionContext: ExecutionContext;
  intuitiveCoat: IntuitiveFluxCoat;
  modulatedParameters: ModulatedOutput;
  sanitizedPayload: Record<string, unknown>;
};

export type SealedPipelineOutcome = SealedPipelineResult | GroundedFaultResult;

export class WrappedCorePipeline {
  /**
   * The complete end-to-end wrapped core execution path.
   * From In-Gate preflight to Deep Isolation Placement, Chaos Fluctuations,
   * ready for provider dispatch & End-Gate vault delivery.
   * Ground-protected: quarantine / spikes return GROUNDED_FAULT instead of crashing.
   */
  static async executeSealedPipeline(
    userId: string,
    tier: ExecutionTier,
    rawPayload: unknown,
  ): Promise<SealedPipelineOutcome> {
    // 1. MINT BASE EXECUTION CONTEXT
    const ctx = ContextFactory.create(userId, tier, "core-execution-runner");

    return executeWithGroundProtection(ctx, async () => {
      // 2. PERIMETER PROACTIVE DEFENSE (Stops bad states & saves token spend)
      const preflight = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
      if (!preflight.allowed) {
        throw new Error(
          `[PREFLIGHT REJECTED] ${preflight.reason ?? "FLOW_ENFORCEMENT_REJECTED"}: ${
            preflight.mitigationAction ?? "Request rejected by proactive flow enforcer."
          }`,
        );
      }

      // 3. BINARY ENTANGLEMENT SUPPRESSION (Severs shared memory references)
      const payloadRecord = toPayloadRecord(rawPayload);
      const isolatedPayload = BinaryEntanglementSuppressor.suppressCrossTalk(ctx, payloadRecord);

      // 4. DEEP ISOLATION CORE PLACEMENT (Reactor scrub + cluster routing + saturation fallback)
      const placement = await DeepIsolationPlacement.routeAndPlace(ctx, isolatedPayload);
      if (placement.securityVerdict === "QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Payload quarantined at node ${placement.targetClusterNode} (Nonce: ${placement.reactorNonce})`,
        );
      }

      const prompt = extractPrompt(placement.sanitizedPayload);
      const baseTemp = extractTemperature(placement.sanitizedPayload, 0.72);

      // 5. INTUITIVE FLUCTUATION & CHAOTIC DRIFT (Logistic map organic parameter variation)
      const fluxCoated = IntuitiveStateFluctuator.fluxCoatWithIntuition(ctx, prompt, baseTemp);

      // 6. FINAL FLUCTUATOR ENGINE MODULATION (Interpretive logic + formula intuition + CTX seal)
      const title =
        typeof placement.sanitizedPayload.title === "string"
          ? placement.sanitizedPayload.title
          : undefined;
      const style =
        typeof placement.sanitizedPayload.style === "string"
          ? placement.sanitizedPayload.style
          : typeof placement.sanitizedPayload.genre === "string"
            ? placement.sanitizedPayload.genre
            : undefined;

      const finalModulation = CtxFluctuatorEngine.modulate(ctx, fluxCoated.prompt || prompt, {
        title,
        style,
      });

      // 7. SEALED EXECUTION RETURN (Ready for provider dispatch & End-Gate vault delivery)
      return {
        status: "SEALED_AND_EXECUTING" as const,
        assignedNode: placement.targetClusterNode,
        isolationNonce: placement.reactorNonce,
        isolationLevel: placement.isolationLevel,
        securityVerdict: placement.securityVerdict,
        executionContext: ctx,
        intuitiveCoat: fluxCoated,
        modulatedParameters: finalModulation,
        sanitizedPayload: placement.sanitizedPayload,
      };
    });
  }
}

function toPayloadRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { value: raw ?? null };
}

function extractPrompt(payload: Record<string, unknown>): string {
  for (const key of ["prompt", "genre", "style"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractTemperature(payload: Record<string, unknown>, fallback: number): number {
  const raw = payload.temperature;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
