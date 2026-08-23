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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .rpc("spend_hybrid_tokens", {
        _user_id: input.userId,
        _amount: input.amount,
        _note: input.note || "Studio master generation",
        _idempotency_key: input.idempotencyKey || undefined,
      })
      .maybeSingle();
    if (error || !row?.ok) {
      console.warn(
        "[Settlement] token debit failed",
        error?.message ?? row?.reason ?? "unknown",
      );
      return false;
    }
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
}): Promise<void> {
  await completeGenerationTask({
    taskId: input.trackId,
    userId: input.userId,
    audioUrl: input.masterUrl,
  });

  const supabase = createEngineSupabaseClient();
  if (!supabase) return;
  const now = new Date().toISOString();

  // Best-effort extras — soft-fail if columns are absent (no forced migrations).
  const vaultPatch: Record<string, unknown> = {
    status: "completed",
    master_url: input.masterUrl,
    instrumental_url: input.instrumentalUrl,
    vocal_url: input.vocalUrl,
  };
  await supabase
    .from("user_vault")
    .update(vaultPatch as never)
    .eq("id", input.trackId)
    .eq("user_id", input.userId)
    .then(({ error }) => {
      if (error) console.warn("[Settlement] user_vault patch:", error.message);
    });

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
    .update(taskPatch as never)
    .eq("id", input.trackId)
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
    .eq("id", input.trackId)
    .eq("user_id", input.userId)
    .then(({ error }) => {
      if (error) console.warn("[Settlement] studio_tracks patch:", error.message);
    });
}

/**
 * Zero-charge rollback when the binary mask is incomplete.
 * Purges temps and marks the task failed — never debits Hybrid Tokens.
 */
export async function executeZeroChargeRollback(input: {
  gateMask: number;
  trackId: string;
  userId: string;
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
    userId: input.userId,
    reason: input.reason,
  }).catch(() => undefined);
  await purgeSettlementBuffers(input.residue, input.tmpPaths);
  return {
    status: "rolled_back",
    gateMask: input.gateMask,
    finalGateMask: input.gateMask,
    trackId: input.trackId,
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
      reason: `Incomplete gate mask ${input.gateMask} (need ${PIPELINE_COMPLETE})`,
      residue: input.residue,
      tmpPaths: input.tmpPaths,
    });
    return { ok: false, ui };
  }

  console.log(
    `[Settlement] PIPELINE_COMPLETE (63) — finalizing track=${input.trackId} totalCharged=$${totalCharged.toFixed(2)} lines=${chargeLedger.length}`,
  );

  await finalizeDatabaseRecord({ ...input, totalCharged, chargeLedger });

  // Hybrid Tokens are whole units — map USD line total with ceil (min 1).
  const tokenAmount =
    input.tokenAmount ?? Math.max(1, Math.ceil(totalCharged - 1e-9) || 1);

  const tokenSettled = await settleHybridToken({
    userId: input.userId,
    amount: tokenAmount,
    idempotencyKey: input.idempotencyKey ?? `pipeline:${input.trackId}`,
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
    tokenSettled,
    totalCharged: ui.totalCharged,
    lines: chargeLedger.map((l) => l.gate),
    masterUrl: ui.masterUrl?.slice(0, 64),
  });

  return { ok: true, ui };
}
