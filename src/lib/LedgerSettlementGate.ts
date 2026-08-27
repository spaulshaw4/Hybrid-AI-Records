/**
 * Ledger Settlement Gate — autonomous vault/token audit seal.
 *
 * Finalizes a successful generation: commits ledger telemetry, stamps
 * distribution routing by tier, and returns a SettlementReceipt for End-Gate
 * confirmation. Token burn already happened at Cortex In-Gate; this gate
 * reconciles the accounting trail once the asset lands in the vault.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { TelemetryAlignment } from "@/lib/TelemetryAlignment";

export type PublisherSyncStatus = "QUEUED_FOR_DISTRIBUTION" | "VAULT_STORED_LOCAL";

export type SettlementReceipt = {
  settlementId: string;
  vaultAssetId: string;
  tokenCostDeducted: number;
  publisherSyncStatus: PublisherSyncStatus;
  tier: string;
  requestId: string;
  jobId?: string;
};

export class LedgerSettlementGate {
  /**
   * Finalizes the generation run: settles atomic token charges in the audit
   * ledger, commits the asset reference, and cues distribution handoffs.
   */
  static async settleAndClose(
    ctx: ExecutionContext,
    vaultAssetId: string,
    generationCost = 1,
  ): Promise<SettlementReceipt> {
    const assetId = vaultAssetId?.trim();
    if (!assetId) {
      throw new Error("Ledger Settlement Rejection: missing vaultAssetId.");
    }

    const cost = Math.max(0, Math.trunc(generationCost || 0));
    const settlementId = `settle_${ctx.sessionNonce}_${Date.now()}`;
    const publisherSyncStatus: PublisherSyncStatus =
      ctx.tier === "enterprise" ? "QUEUED_FOR_DISTRIBUTION" : "VAULT_STORED_LOCAL";

    await TelemetryAlignment.recordEvent(ctx, {
      eventType: "LEDGER_SETTLEMENT_COMMITTED",
      status: "SUCCESS",
      details: {
        settlementId,
        vaultAssetId: assetId,
        tokenCostDeducted: cost,
        publisherSyncStatus,
      },
    });

    console.info("[ledger-settlement] committed", {
      settlementId,
      vaultAssetId: assetId,
      tier: ctx.tier,
      tokenCostDeducted: cost,
      publisherSyncStatus,
      requestId: ctx.requestId,
      jobId: ctx.jobId ?? null,
    });

    return {
      settlementId,
      vaultAssetId: assetId,
      tokenCostDeducted: cost,
      publisherSyncStatus,
      tier: ctx.tier,
      requestId: ctx.requestId,
      ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
    };
  }
}
