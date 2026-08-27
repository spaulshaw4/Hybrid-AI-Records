/**
 * Fully Plugged Core Pipeline — perimeter → settlement closed circuit.
 *
 * Composes proactive defense, entanglement suppression, deep isolation,
 * chaotic fluctuation, mock vault handoff, ledger settlement, and isolated
 * ground diversion into one sealed runner for architecture smoke / dry-runs.
 * Production worker path still uses Cortex queue → provider → End-Gate.
 */

import type { ExecutionTier } from "@/lib/ExecutionContext";
import { ContextFactory } from "@/lib/ExecutionContext";
import { ProactiveFlowEnforcer } from "@/lib/ProactiveFlowEnforcer";
import { BinaryEntanglementSuppressor } from "@/lib/BinaryEntanglementSuppressor";
import { DeepIsolationPlacement } from "@/lib/DeepIsolationPlacement";
import { IntuitiveStateFluctuator } from "@/lib/IntuitiveStateFluctuator";
import { CtxFluctuatorEngine } from "@/lib/CtxFluctuatorEngine";
import {
  IsolatedGroundConnector,
  type GroundFaultPayload,
} from "@/lib/IsolatedGroundConnector";
import {
  LedgerSettlementGate,
  type SettlementReceipt,
} from "@/lib/LedgerSettlementGate";

export type PluggedCircuitGrounded = {
  status: "CIRCUIT_GROUNDED_FAULT";
  groundDrainReference: string;
  faultSource: string;
  errorCode: string;
};

export type PluggedCircuitOutcome = SettlementReceipt | PluggedCircuitGrounded;

export class FullyPluggedCorePipeline {
  /**
   * Executes the entire closed-loop architecture:
   * Preflight → Binary Suppression → Deep Isolation Placement →
   * Chaotic Fluctuation → Execution handoff → Ground Protection → Ledger Settlement.
   */
  static async executePluggedCircuit(
    userId: string,
    tier: ExecutionTier,
    rawPayload: unknown,
  ): Promise<PluggedCircuitOutcome> {
    // 1. MINT CONTEXT
    const ctx = ContextFactory.create(userId, tier, "plugged-circuit-runner");

    try {
      // 2. PERIMETER PROACTIVE DEFENSE
      const preflight = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
      if (!preflight.allowed) {
        throw new Error(
          `[PREFLIGHT REJECTED] ${preflight.reason ?? "FLOW_ENFORCEMENT_REJECTED"}: ${
            preflight.mitigationAction ?? "Request rejected by proactive flow enforcer."
          }`,
        );
      }

      // 3. BINARY ENTANGLEMENT SUPPRESSION
      const payloadRecord = toPayloadRecord(rawPayload);
      const isolatedPayload = BinaryEntanglementSuppressor.suppressCrossTalk(
        ctx,
        payloadRecord,
      );

      // 4. DEEP ISOLATION CORE PLACEMENT
      const placement = await DeepIsolationPlacement.routeAndPlace(ctx, isolatedPayload);
      if (placement.securityVerdict === "QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Payload quarantined at node ${placement.targetClusterNode} (Nonce: ${placement.reactorNonce})`,
        );
      }

      const prompt = extractPrompt(placement.sanitizedPayload);
      const baseTemp = extractTemperature(placement.sanitizedPayload, 0.72);

      // 5. CHAOTIC INTUITIVE FLUCTUATION
      const fluxCoated = IntuitiveStateFluctuator.fluxCoatWithIntuition(ctx, prompt, baseTemp);

      // 6. FLUCTUATOR ENGINE MODULATION
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

      // 7. MOCK WORKER EXECUTION & VAULT STORAGE HANDOFF
      // Production: dispatch finalModulation via Cortex worker → provider → End-Gate.
      const mockVaultAssetId = `vault_asset_${ctx.sessionNonce}_${Date.now()}`;
      void finalModulation;

      // 8. LEDGER SETTLEMENT GATE
      return await LedgerSettlementGate.settleAndClose(ctx, mockVaultAssetId, 1);
    } catch (error: unknown) {
      // 9. ISOLATED GROUND CONNECTOR
      const err = error as { code?: string; message?: string; stack?: string };
      const groundPayload: GroundFaultPayload = {
        errorCode: err?.code || "CIRCUIT_EXECUTION_FAULT",
        faultSource: IsolatedGroundConnector.classifyFaultSource(error),
        rawContaminatedData: err?.stack || err?.message || String(error ?? "unknown"),
        drainNonce: `drain_${ctx.sessionNonce}`,
      };
      const groundDrainReference = await IsolatedGroundConnector.drainFaultToGround(
        ctx,
        groundPayload,
      );
      return {
        status: "CIRCUIT_GROUNDED_FAULT",
        groundDrainReference,
        faultSource: groundPayload.faultSource,
        errorCode: groundPayload.errorCode,
      };
    }
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
