/**
 * Multi-tenant generation queue — thin façade over the cortex dispatcher.
 * Prefer `executeGenerationCortex` for new call sites.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  executeGenerationCortex,
  type CortexAccepted,
} from "@/lib/cortex-dispatcher.server";

export type GenerationQueueStatus = "pending" | "processing" | "completed" | "failed";

export type GenerationQueueRow = {
  id: string;
  user_id: string;
  vault_id: string | null;
  prompt_payload: Database["public"]["Tables"]["generation_queue"]["Row"]["prompt_payload"];
  status: GenerationQueueStatus;
  spend_idempotency_key: string | null;
  error_message: string | null;
  result: Database["public"]["Tables"]["generation_queue"]["Row"]["result"];
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  assigned_node?: string | null;
};

export type EnqueueGenerationResult = {
  ok: true;
  message: string;
  queueId: string;
  vaultId: string | null;
  status: "pending";
  balance: number;
  tokenBypassed: boolean;
  correlationId: string;
  userId: string;
};

type Db = SupabaseClient<Database>;

/** @deprecated Prefer `executeGenerationCortex` — this wraps the three cortex gates. */
export async function enqueueGenerationJob(input: {
  userId: string;
  supabase: Db;
  body: unknown;
}): Promise<EnqueueGenerationResult> {
  const accepted: CortexAccepted = await executeGenerationCortex({
    userId: input.userId,
    supabase: input.supabase,
    promptPayload: input.body,
  });
  return {
    ok: true,
    message: accepted.message,
    queueId: accepted.queueId,
    vaultId: accepted.vaultId,
    status: "pending",
    balance: accepted.balance,
    tokenBypassed: accepted.tokenBypassed,
    correlationId: accepted.correlationId,
    userId: accepted.userId,
  };
}

export async function getGenerationQueueJobForUser(
  userId: string,
  jobId: string,
): Promise<GenerationQueueRow | null> {
  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = requireSupabaseAdmin();
  const { data, error } = await admin
    .from("generation_queue")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("[generation-queue] get failed", error.message);
    return null;
  }
  return (data as GenerationQueueRow | null) ?? null;
}
