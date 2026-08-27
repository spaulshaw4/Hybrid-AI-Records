/**
 * End-Gate Dispatcher — final delivery checkpoint for generation jobs.
 *
 * Ensures finished audio is strictly written to the requesting user's vault
 * (job.user_id) and never leaks to admin/shared defaults. Failures trigger an
 * atomic refund for that same user and mark the queue job failed.
 */

import type { Json } from "@/integrations/supabase/types";
import type { ExecutionContext, ExecutionTier } from "@/lib/ExecutionContext";
import type { SettlementReceipt } from "@/lib/LedgerSettlementGate";

export type EndGateDeliveryPayload = {
  jobId: string;
  /** Original queued owner — never remapped. */
  userId: string;
  audioUrl: string;
  prompt: string;
  providerName: string;
  title?: string;
  style?: string;
  vaultId?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  rawAudioUrl?: string | null;
  providerTaskId?: string | null;
  spendIdempotencyKey?: string | null;
  correlationId?: string;
  /** Extra result blob stored on generation_queue.result. */
  result?: Record<string, unknown>;
  /** Optional sealed CTX for ledger settlement (preferred). */
  executionContext?: ExecutionContext;
  generationCost?: number;
};

export type EndGateDeliveryResult = {
  vaultId: string;
  settlement: SettlementReceipt;
};

export class EndGateRejectionError extends Error {
  readonly statusCode = 500 as const;

  constructor(message: string) {
    super(message);
    this.name = "EndGateRejectionError";
  }
}

export class EndGateDispatcher {
  /**
   * End-Gate checkpoint: deliver a finished track to the caller's vault only,
   * settle the generation_queue row as completed, then seal the ledger receipt.
   */
  static async deliverToUserVault(
    payload: EndGateDeliveryPayload,
  ): Promise<EndGateDeliveryResult> {
    // Flux Coating: reject contaminated delivery payloads before vault write.
    // Strip non-schema fields before coat; reattach after.
    const executionContext = payload.executionContext;
    const generationCost = payload.generationCost;
    let coated: Omit<EndGateDeliveryPayload, "executionContext" | "generationCost">;
    try {
      const { PipelineFluxCoating } = await import("@/lib/PipelineFluxCoating");
      const { executionContext: _ctx, generationCost: _cost, ...fluxSafe } = payload;
      coated = PipelineFluxCoating.coatEndGate(fluxSafe) as Omit<
        EndGateDeliveryPayload,
        "executionContext" | "generationCost"
      >;
    } catch (error) {
      throw new EndGateRejectionError(
        error instanceof Error
          ? error.message
          : "End-Gate Rejection: Flux coating failed on delivery payload.",
      );
    }

    const ownerId = coated.userId?.trim();
    if (!ownerId) {
      throw new EndGateRejectionError(
        "End-Gate Rejection: Missing user context binding for track delivery.",
      );
    }
    if (!coated.jobId?.trim()) {
      throw new EndGateRejectionError("End-Gate Rejection: Missing job id.");
    }
    if (!coated.audioUrl?.trim()) {
      throw new EndGateRejectionError("End-Gate Rejection: Missing audio URL.");
    }

    // Explicitly refuse the well-known local-dev UUID as a delivery target.
    if (ownerId === "11111111-1111-4111-8111-111111111111") {
      throw new EndGateRejectionError(
        "End-Gate Rejection: Developer override identity is blocked for vault delivery.",
      );
    }

    const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const admin = requireSupabaseAdmin();

    // Vault persistence — strictly stamp with the job's original owner.
    let vaultId: string | null;
    try {
      vaultId = await persistUserVault(admin, ownerId, {
        id: coated.vaultId ?? undefined,
        title: coated.title || "Untitled Track",
        style: coated.style || coated.prompt,
        status: "completed",
        masterUrl: coated.audioUrl,
        instrumentalUrl: coated.instrumentalUrl ?? undefined,
        vocalUrl: coated.vocalUrl ?? undefined,
        rawAudioUrl: coated.rawAudioUrl ?? undefined,
        providerTaskId: coated.providerTaskId ?? undefined,
        tokensUsed: Math.max(1, Math.trunc(generationCost ?? 1)),
      });
    } catch (error) {
      throw new EndGateRejectionError(
        `End-Gate Vault Write Failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!vaultId) {
      throw new EndGateRejectionError(
        `End-Gate Vault Write Failed: no vault id returned for user ${ownerId}`,
      );
    }

    // Ledger Settlement Gate — audit seal once the asset has landed.
    const { ContextFactory } = await import("@/lib/ExecutionContext");
    const { LedgerSettlementGate } = await import("@/lib/LedgerSettlementGate");
    const settleCtx =
      executionContext && executionContext.userId === ownerId
        ? executionContext
        : ContextFactory.create(
            ownerId,
            extractTierHint(coated.result),
            "cortex-worker",
            {
              jobId: coated.jobId,
              requestId: coated.correlationId,
            },
          );

    const settlement = await LedgerSettlementGate.settleAndClose(
      settleCtx,
      vaultId,
      generationCost ?? 1,
    );

    const queueResult: Json = {
      ...(coated.result ?? {}),
      vaultId,
      audioUrl: coated.audioUrl,
      provider: coated.providerName,
      delivered_via: "end-gate",
      correlationId: coated.correlationId ?? null,
      ledgerSettlement: settlement,
    } as Json;

    // Job settlement — vault succeeded; queue update is best-effort warn.
    const { error: queueError } = await admin
      .from("generation_queue")
      .update({
        status: "completed",
        result: queueResult,
        error_message: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", coated.jobId)
      .eq("user_id", ownerId);

    if (queueError) {
      console.error(
        `Warning: Job ${coated.jobId} vault write succeeded, but queue status update failed.`,
        queueError.message,
      );
    }

    console.info("[end-gate] delivered", {
      jobId: coated.jobId,
      userId: ownerId,
      vaultId,
      provider: coated.providerName,
      correlationId: coated.correlationId ?? null,
      settlementId: settlement.settlementId,
      publisherSyncStatus: settlement.publisherSyncStatus,
    });

    return { vaultId, settlement };
  }

  /**
   * End-Gate failure safe: automatic token refund + mark job failed for THIS user.
   */
  static async handleDeliveryFailure(input: {
    jobId: string;
    userId: string;
    errorMessage: string;
    spendIdempotencyKey?: string | null;
    vaultId?: string | null;
  }): Promise<void> {
    const ownerId = input.userId?.trim();
    const jobId = input.jobId?.trim();
    if (!ownerId || !jobId) {
      console.error("[end-gate] handleDeliveryFailure missing job/user binding", input);
      return;
    }

    // Refund tokens atomically back to THIS specific user (idempotent key).
    if (input.spendIdempotencyKey) {
      try {
        const { refundGenerationToken } = await import("@/lib/generation-tokens.server");
        await refundGenerationToken({
          userId: ownerId,
          amount: 1,
          spendIdempotencyKey: input.spendIdempotencyKey,
          note: `Refund: end-gate failure — ${input.errorMessage.slice(0, 160)}`,
        });
      } catch (refundErr) {
        console.error(
          "[end-gate] refund threw",
          refundErr instanceof Error ? refundErr.message : refundErr,
        );
      }
    }

    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return;

      await admin
        .from("generation_queue")
        .update({
          status: "failed",
          error_message: input.errorMessage.slice(0, 1000),
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", jobId)
        .eq("user_id", ownerId);

      if (input.vaultId) {
        const { persistUserVault } = await import("@/lib/user-vault.server");
        await persistUserVault(admin, ownerId, {
          id: input.vaultId,
          title: "Untitled Track",
          status: "failed",
        }).catch(() => undefined);
      }
    } catch (markErr) {
      console.error(
        "[end-gate] mark-failed threw",
        markErr instanceof Error ? markErr.message : markErr,
      );
    }
  }
}

function extractTierHint(result?: Record<string, unknown>): ExecutionTier {
  const nested = result?.executionContext;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const tier = (nested as { tier?: unknown }).tier;
    if (tier === "enterprise" || tier === "pro" || tier === "free") return tier;
  }
  return "free";
}
