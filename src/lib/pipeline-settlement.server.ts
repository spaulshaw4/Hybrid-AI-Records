/**
 * Post-binary settlement — runs only when gateMask === PIPELINE_COMPLETE (63).
 * Incomplete masks take the zero-charge rollback path (no token debit).
 */

import { createEngineSupabaseClient, completeGenerationTask, failGenerationTask } from "@/lib/engine-pipeline.server";
import {
  PIPELINE_COMPLETE,
  missingGateNames,
  totalChargedFromLedger,
  type ChargeLedgerEntry,
} from "@/lib/pipeline-flags";
import { cleanupOrphanTempFiles } from "@/lib/pipeline-worker.server";
import type { MusicSectionMarker } from "@/types/pipeline";
import type { ResidueCleanup } from "@/lib/six-gate-landing.server";

export type PostBinarySettlementInput = {
  gateMask: number;
  trackId: string;
  userId: string;
  /** Client-opened `user_vault` row (UUID). Prefer over MusicAPI task id. */
  vaultId?: string | null;
  masterUrl: string;
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  publicAudioUrl?: string | null;
  structuralMarkers: MusicSectionMarker[];
  duration: number;
  title?: string;
  idempotencyKey?: string;
  /** Override Hybrid Token debit; default derived from chargeLedger total. */
  tokenAmount?: number;
  /** Sequential line-item charges accrued during gate execution. */
  chargeLedger?: ChargeLedgerEntry[];
  residue?: ResidueCleanup;
  tmpPaths?: string[];
};

export type PostBinaryUiPayload = {
  status: "settled" | "rolled_back";
  gateMask: number;
  finalGateMask: number;
  trackId: string;
  /** Confirmed `user_vault.id` after service-role upsert (when available). */
  vaultId: string | null;
  masterUrl: string | null;
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  structuralMarkers: MusicSectionMarker[];
  duration: number;
  tokenSettled: boolean;
  missingGates?: string[];
  /** Itemized compute billing receipt for the studio UI. */
  chargeLedger: ChargeLedgerEntry[];
  totalCharged: number;
};

export type PostBinarySettlementResult = {
  ok: boolean;
  ui: PostBinaryUiPayload;
};

async function purgeSettlementBuffers(
  residue?: ResidueCleanup,
  tmpPaths: string[] = [],
): Promise<void> {
  await residue?.dispose().catch(() => undefined);
  const { cleanupAudioWriteResidue } = await import("@/lib/track-lock.server");
  await Promise.all(tmpPaths.map((p) => cleanupAudioWriteResidue(p).catch(() => undefined)));
  await cleanupOrphanTempFiles({ maxAgeMs: 0 }).catch(() => undefined);
}

async function settleHybridToken(input: {
  userId: string;
  amount: number;
  idempotencyKey?: string;
  note?: string;
}): Promise<boolean> {
  try {
    const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const {
      authorizeAndSpendGenerationToken,
    } = await import("@/lib/generation-tokens.server");
    const admin = requireSupabaseAdmin();
    if (!input.idempotencyKey) {
      console.warn("[Settlement] missing idempotency key — skipping debit");
      return false;
    }
    await authorizeAndSpendGenerationToken({
      userId: input.userId,
      supabase: admin,
      idempotencyKey: input.idempotencyKey,
      amount: input.amount,
      note: input.note || "Studio master generation",
    });
    return true;
  } catch (err) {
    console.warn(
      "[Settlement] token debit threw",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

async function finalizeDatabaseRecord(input: PostBinarySettlementInput & {
  totalCharged: number;
  chargeLedger: ChargeLedgerEntry[];
}): Promise<string | null> {
  const vaultKey = input.vaultId?.trim() || input.trackId;
  console.log("Writing track to vault:", vaultKey);

  let committedVaultId: string | null = input.vaultId?.trim() || null;

  // Canonical service-role upsert — survives SSE client disconnect.
  try {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    const admin = createEngineSupabaseClient();
    if (admin) {
      committedVaultId =
        (await persistUserVault(admin, input.userId, {
          id: input.vaultId ?? undefined,
          title: input.title || "Untitled Track",
          status: "completed",
          masterUrl: input.masterUrl,
          instrumentalUrl: input.instrumentalUrl,
          vocalUrl: input.vocalUrl,
          rawAudioUrl: input.publicAudioUrl,
          tokensUsed: 1,
        })) ?? committedVaultId;
    } else {
      console.error("[Settlement] no service-role client — vault write skipped");
    }
  } catch (error) {
    console.error(
      "[Settlement] persistUserVault threw",
      error instanceof Error ? error.message : error,
    );
  }

  // Bookkeeping for studio_tracks / generation_tasks (UUID keys only).
  // completeGenerationTask also routes vault writes through persistUserVault.
  await completeGenerationTask({
    taskId: input.trackId,
    vaultId: committedVaultId ?? input.vaultId ?? input.trackId,
    userId: input.userId,
    audioUrl: input.masterUrl,
    title: input.title,
    instrumentalUrl: input.instrumentalUrl,
    vocalUrl: input.vocalUrl,
    rawAudioUrl: input.publicAudioUrl,
  });

  const supabase = createEngineSupabaseClient();
  if (!supabase) return committedVaultId;
  const now = new Date().toISOString();

  const uuidRe =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const taskIdForBookkeeping =
    (committedVaultId && uuidRe.test(committedVaultId) ? committedVaultId : null) ??
    (input.vaultId && uuidRe.test(input.vaultId) ? input.vaultId : null) ??
    (uuidRe.test(input.trackId) ? input.trackId : null);

  if (!taskIdForBookkeeping) return committedVaultId;

  const taskPatch: Record<string, unknown> = {
    status: "completed",
    audio_url: input.masterUrl,
    updated_at: now,
    final_gate_mask: PIPELINE_COMPLETE,
    total_charged: input.totalCharged,
    charge_ledger: input.chargeLedger,
  };
  await supabase
    .from("generation_tasks")
    .upsert(
      { id: taskIdForBookkeeping, user_id: input.userId, ...taskPatch } as never,
      { onConflict: "id" },
    )
    .then(({ error }) => {
      if (error && !/final_gate_mask|total_charged|charge_ledger|column/i.test(error.message)) {
        console.warn("[Settlement] generation_tasks patch:", error.message);
      }
    });

  await supabase
    .from("studio_tracks")
    .update({
      audio_url: input.masterUrl,
      mastered_status: "ready",
      updated_at: now,
    } as never)
    .eq("id", taskIdForBookkeeping)
    .eq("user_id", input.userId)
    .then(({ error }) => {
      if (error) console.warn("[Settlement] studio_tracks patch:", error.message);
    });

  return committedVaultId;
}

/**
 * Zero-charge rollback when the binary mask is incomplete.
 * Purges temps and marks the task failed — never debits Hybrid Tokens.
 */
export async function executeZeroChargeRollback(input: {
  gateMask: number;
  trackId: string;
  userId: string;
  vaultId?: string | null;
  reason: string;
  residue?: ResidueCleanup;
  tmpPaths?: string[];
}): Promise<PostBinaryUiPayload> {
  const missing = missingGateNames(input.gateMask);
  console.error(
    `[Settlement Rollback] gateMask=0b${input.gateMask.toString(2)} (${input.gateMask}) missing=[${missing.join(",")}] — ${input.reason}`,
  );
  await failGenerationTask({
    taskId: input.trackId,
    vaultId: input.vaultId,
    userId: input.userId,
    reason: input.reason,
  }).catch(() => undefined);
  await purgeSettlementBuffers(input.residue, input.tmpPaths);
  return {
    status: "rolled_back",
    gateMask: input.gateMask,
    finalGateMask: input.gateMask,
    trackId: input.trackId,
    vaultId: input.vaultId?.trim() || null,
    masterUrl: null,
    vocalUrl: null,
    instrumentalUrl: null,
    structuralMarkers: [],
    duration: 0,
    tokenSettled: false,
    missingGates: missing,
    chargeLedger: [],
    totalCharged: 0,
  };
}

/**
 * Post-binary settlement — only when gateMask === 63 (PIPELINE_COMPLETE).
 */
export async function executePostBinarySettlement(
  input: PostBinarySettlementInput,
): Promise<PostBinarySettlementResult> {
  const chargeLedger = input.chargeLedger ?? [];
  const totalCharged = totalChargedFromLedger(chargeLedger);

  if (input.gateMask !== PIPELINE_COMPLETE) {
    const ui = await executeZeroChargeRollback({
      gateMask: input.gateMask,
      trackId: input.trackId,
      userId: input.userId,
      vaultId: input.vaultId,
      reason: `Incomplete gate mask ${input.gateMask} (need ${PIPELINE_COMPLETE})`,
      residue: input.residue,
      tmpPaths: input.tmpPaths,
    });
    return { ok: false, ui };
  }

  console.log(
    `[Settlement] PIPELINE_COMPLETE (63) — finalizing track=${input.trackId} totalCharged=$${totalCharged.toFixed(2)} lines=${chargeLedger.length}`,
  );

  const committedVaultId = await finalizeDatabaseRecord({
    ...input,
    totalCharged,
    chargeLedger,
  });

  // Silent background email — Certificate of Creation + master download link.
  // Soft-fail and never blocks settlement / UI payload.
  void (async () => {
    try {
      const { sendTrackCompletionReceipt } = await import("@/lib/resend.server");
      await sendTrackCompletionReceipt({
        userId: input.userId,
        trackId: input.trackId,
        trackTitle: input.title?.trim() || "Untitled Track",
        masterDownloadUrl: input.masterUrl,
      });
    } catch (err) {
      console.warn(
        "[Settlement] track completion email soft-fail",
        err instanceof Error ? err.message : err,
      );
    }
  })();

  // Hybrid Tokens are whole units — map USD line total with ceil (min 1).
  const tokenAmount =
    input.tokenAmount ?? Math.max(1, Math.ceil(totalCharged - 1e-9) || 1);

  // Same key as authorizeAndSpendGenerationToken — alreadyApplied when burned at queue.
  const { generationTokenIdempotencyKey } = await import("@/lib/generation-tokens.server");
  const tokenSettled = await settleHybridToken({
    userId: input.userId,
    amount: tokenAmount,
    idempotencyKey:
      input.idempotencyKey ?? generationTokenIdempotencyKey(input.trackId),
    note:
      input.title ||
      `Studio master ($${totalCharged.toFixed(2)} line items → ${tokenAmount} token)`,
  });

  await purgeSettlementBuffers(input.residue, input.tmpPaths);

  const ui: PostBinaryUiPayload = {
    status: "settled",
    gateMask: PIPELINE_COMPLETE,
    finalGateMask: PIPELINE_COMPLETE,
    trackId: input.trackId,
    vaultId: committedVaultId ?? input.vaultId?.trim() ?? null,
    masterUrl: input.masterUrl,
    vocalUrl: input.vocalUrl,
    instrumentalUrl: input.instrumentalUrl,
    structuralMarkers: input.structuralMarkers,
    duration: input.duration,
    tokenSettled,
    chargeLedger,
    totalCharged,
  };

  console.log("[Settlement] UI payload ready", {
    trackId: ui.trackId,
    vaultId: ui.vaultId,
    tokenSettled,
    totalCharged: ui.totalCharged,
    lines: chargeLedger.map((l) => l.gate),
    masterUrl: ui.masterUrl?.slice(0, 64),
  });

  return { ok: true, ui };
}
