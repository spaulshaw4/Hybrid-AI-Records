/**
 * THE CORTEX DISPATCHER — multi-tenant generation control plane.
 *
 * Every studio generation request must pass three sequential gates:
 *
 *   Gate 1 — Identity & Token Authorization ("The Bouncer")
 *   Gate 2 — Queue & Throttler ("The Traffic Controller")
 *   Gate 3 — Profile-Bound Vault Writer ("The Delivery Driver")
 *            opened at enqueue; completed by the sequential worker after the
 *            shared upstream API key finishes the job.
 *
 * TanStack equivalent of the Next.js `@supabase/ssr` + cookies pattern:
 * request-scoped `resolveStudioSession` / `auth.getUser()` — never a shared
 * DEV UUID or admin identity for consumer generations.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/integrations/supabase/types";
import {
  type GenerateEngineTrackInput,
} from "@/lib/apiframe-music.functions";
import { newCorrelationId } from "@/lib/engine-log.server";
import { RATE_LIMITS, limitBy } from "@/lib/rate-limit";
import {
  UnauthorizedSessionError,
  type StudioSession,
} from "@/lib/studio-request-auth.server";
import {
  InGateRejectionError,
  UserContextIngate,
} from "@/lib/UserContextIngate";

export type CortexAccepted = {
  success: true;
  message: string;
  correlationId: string;
  queueId: string;
  vaultId: string | null;
  userId: string;
  status: "pending";
  balance: number;
  tokenBypassed: boolean;
};

type Db = SupabaseClient<Database>;

export class CortexGateError extends Error {
  readonly gate: 1 | 2 | 3;
  readonly statusCode: number;

  constructor(gate: 1 | 2 | 3, statusCode: number, message: string) {
    super(message);
    this.name = "CortexGateError";
    this.gate = gate;
    this.statusCode = statusCode;
  }
}

/**
 * Central interceptor for all generation requests.
 * Assigns a correlation ID, runs Gate 1 + Gate 2, opens the Gate 3 vault row,
 * and returns immediately so the sequential worker can drain the shared key.
 */
export async function executeGenerationCortex(input: {
  /** Incoming HTTP request (Bearer / Supabase auth cookies). */
  request?: Request;
  /** Pre-verified session (server-fn middleware). Mutually exclusive with loose auth. */
  session?: StudioSession;
  /** Already-resolved user id + client when middleware already authenticated. */
  userId?: string;
  supabase?: Db;
  /** Raw studio generate payload (prompt, lyrics, controls, …). */
  promptPayload: unknown;
}): Promise<CortexAccepted> {
  const correlationId = newCorrelationId("cortex");

  // -------------------------------------------------------------------------
  // MASTER ACTIVATOR SWITCH — global arm / maintenance / disable interlock
  // -------------------------------------------------------------------------
  {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    const switchStatus = await PipelineActivatorSwitch.verifySystemArmed();
    if (!switchStatus.armed) {
      throw new CortexGateError(
        1,
        503,
        `Generation pipeline is currently offline. State: ${switchStatus.state}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // GATE 1: Identity & Token Authorization (The Bouncer)
  // -------------------------------------------------------------------------
  const gate1 = await cortexGate1IdentityAndTokens({
    request: input.request,
    session: input.session,
    userId: input.userId,
    supabase: input.supabase,
    promptPayload: input.promptPayload,
    correlationId,
  });

  // -------------------------------------------------------------------------
  // GATE 2: Queue & Throttler (The Traffic Controller)
  // -------------------------------------------------------------------------
  try {
    const gate2 = await cortexGate2Enqueue({
      userId: gate1.userId,
      supabase: gate1.supabase,
      admin: gate1.admin,
      data: gate1.data,
      spendKey: gate1.spendKey,
      runKey: gate1.runKey,
      tokenAuth: gate1.tokenAuth,
      vaultId: gate1.vaultId,
      correlationId,
    });

    console.info("[cortex] accepted", {
      correlationId,
      userId: gate1.userId,
      queueId: gate2.queueId,
      vaultId: gate2.vaultId,
    });

    return {
      success: true,
      message: "Generation queued successfully",
      correlationId,
      queueId: gate2.queueId,
      vaultId: gate2.vaultId,
      userId: gate1.userId,
      status: "pending",
      balance: gate1.tokenAuth.balance,
      tokenBypassed: gate1.tokenAuth.bypassed,
    };
  } catch (error) {
    // Instant safety rollback if queue ingestion drops after a successful burn.
    if (!gate1.tokenAuth.bypassed) {
      const { refundGenerationToken } = await import("@/lib/generation-tokens.server");
      await refundGenerationToken({
        userId: gate1.userId,
        amount: 1,
        spendIdempotencyKey: gate1.spendKey,
        note: `Refund: cortex Gate 2 failed [${correlationId}]`,
      }).catch(() => undefined);
      const { PipelineInformant } = await import("@/lib/PipelineInformant");
      PipelineInformant.emit({
        eventType: "TOKEN_REFUND",
        userId: gate1.userId,
        metadata: {
          reason: "cortex_gate2_enqueue_failed",
          correlationId,
          spendIdempotencyKey: gate1.spendKey,
        },
      });
    }
    if (error instanceof CortexGateError) throw error;
    throw new CortexGateError(
      2,
      500,
      error instanceof Error
        ? error.message
        : "Queue ingestion failed. Tokens automatically refunded.",
    );
  }
}

/**
 * GATE 3 delivery sink — called by the sequential worker after the shared
 * upstream key finishes. Always binds `user_vault` to the queued job's user_id.
 */
export async function cortexGate3DeliverToVault(input: {
  userId: string;
  vaultId?: string | null;
  title?: string;
  style?: string;
  masterUrl: string;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  rawAudioUrl?: string | null;
  providerTaskId?: string | null;
  correlationId?: string;
}): Promise<string> {
  const ownerId = input.userId?.trim();
  if (!ownerId) {
    throw new CortexGateError(3, 500, "Gate 3 refused delivery: missing user UUID.");
  }

  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { persistUserVault } = await import("@/lib/user-vault.server");
  const admin = requireSupabaseAdmin();

  const vaultId = await persistUserVault(admin, ownerId, {
    id: input.vaultId ?? undefined,
    title: input.title || "Untitled Track",
    style: input.style,
    status: "completed",
    masterUrl: input.masterUrl,
    instrumentalUrl: input.instrumentalUrl ?? undefined,
    vocalUrl: input.vocalUrl ?? undefined,
    rawAudioUrl: input.rawAudioUrl ?? undefined,
    providerTaskId: input.providerTaskId ?? undefined,
    tokensUsed: 1,
  });

  if (!vaultId) {
    throw new CortexGateError(
      3,
      500,
      `Gate 3 vault write failed for user ${ownerId}`,
    );
  }

  console.info("[cortex] Gate 3 delivered", {
    correlationId: input.correlationId ?? null,
    userId: ownerId,
    vaultId,
    hasMaster: Boolean(input.masterUrl),
  });

  return vaultId;
}

// ---------------------------------------------------------------------------
// Gate implementations
// ---------------------------------------------------------------------------

async function cortexGate1IdentityAndTokens(input: {
  request?: Request;
  session?: StudioSession;
  userId?: string;
  supabase?: Db;
  promptPayload: unknown;
  correlationId: string;
}): Promise<{
  userId: string;
  supabase: Db;
  admin: Db;
  data: GenerateEngineTrackInput;
  spendKey: string;
  runKey: string;
  vaultId: string | null;
  tokenAuth: {
    bypassed: boolean;
    balance: number;
    alreadyApplied: boolean;
    idempotencyKey: string;
  };
}> {
  let userId = "";
  let supabase = input.supabase;

  // In-Gate: absolute user envelope — blocks DEV/admin bleed on consumer generate.
  try {
    if (input.request) {
      const envelope = await UserContextIngate.resolveActiveUser(input.request);
      userId = envelope.userId;
      supabase = envelope.session.supabase;
      if (envelope.isDeveloperOverride) {
        throw new CortexGateError(
          1,
          401,
          "401 In-Gate Rejection: Developer override blocked on consumer generation.",
        );
      }
    } else if (input.session) {
      const envelope = UserContextIngate.fromVerifiedSession(input.session);
      userId = envelope.userId;
      supabase = envelope.session.supabase;
    } else if (input.userId?.trim() && input.supabase) {
      const envelope = UserContextIngate.fromVerifiedUserId(input.userId, {
        userId: input.userId.trim(),
        accessToken: "",
        supabase: input.supabase,
      });
      userId = envelope.userId;
      supabase = envelope.session.supabase;
    }
  } catch (error) {
    if (error instanceof CortexGateError) throw error;
    if (error instanceof InGateRejectionError || error instanceof UnauthorizedSessionError) {
      throw new CortexGateError(1, 401, error.message);
    }
    throw new CortexGateError(
      1,
      401,
      "401 In-Gate Rejection: Unauthorized user session detected.",
    );
  }

  if (!userId) {
    throw new CortexGateError(
      1,
      401,
      "401 In-Gate Rejection: Unauthorized user session detected.",
    );
  }

  limitBy("cortexGenerate", userId, RATE_LIMITS.generation, "track generations");

  let data: GenerateEngineTrackInput;
  try {
    const { PipelineFluxCoating, FluxRejectionError } = await import(
      "@/lib/PipelineFluxCoating"
    );
    data = PipelineFluxCoating.coatInGate(input.promptPayload);
  } catch (error) {
    const { FluxRejectionError } = await import("@/lib/PipelineFluxCoating");
    if (error instanceof FluxRejectionError) {
      throw new CortexGateError(1, 400, error.message);
    }
    throw new CortexGateError(
      1,
      400,
      error instanceof Error ? error.message : "Invalid generation payload.",
    );
  }

  const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = tryGetSupabaseAdmin();
  if (!admin) {
    throw new CortexGateError(
      1,
      500,
      "Generation cortex requires Supabase service role credentials.",
    );
  }
  if (!supabase) supabase = admin;

  // -------------------------------------------------------------------------
  // PROACTIVE FLOW ENFORCEMENT — before token burn / vault / queue locks
  // -------------------------------------------------------------------------
  {
    const { handleIngatePreflight } = await import("@/lib/ProactiveFlowEnforcer");
    const preflight = await handleIngatePreflight({
      userId,
      tier: "free",
      correlationId: input.correlationId,
    });
    if (!preflight.proceedToQueue) {
      throw new CortexGateError(
        1,
        preflight.status,
        `${preflight.error}: ${preflight.message}`,
      );
    }
  }

  const { buildGenerationIdempotencyKey } = await import("@/lib/pipeline-idempotency.server");
  const {
    authorizeAndSpendGenerationToken,
    generationTokenIdempotencyKey,
    InsufficientTokensError,
  } = await import("@/lib/generation-tokens.server");

  const lyricContent = data.instrumental ? "" : data.lyrics;
  const genre = (data.genre || data.style || data.prompt).trim();
  const runKey =
    data.idempotencyKey?.trim() ||
    buildGenerationIdempotencyKey({
      userId,
      prompt: lyricContent || genre,
      style: genre,
      lyrics: lyricContent,
      instrumental: data.instrumental,
    });
  const spendKey = generationTokenIdempotencyKey(runKey);

  console.info("[cortex] Gate 1 burn", {
    correlationId: input.correlationId,
    userId,
    spendKey,
    title: data.title || null,
  });

  let tokenAuth: {
    bypassed: boolean;
    balance: number;
    alreadyApplied: boolean;
    idempotencyKey: string;
  };
  try {
    // Atomic spend_hybrid_tokens RPC (FOR UPDATE row lock) — prevents double-spend.
    tokenAuth = await authorizeAndSpendGenerationToken({
      userId,
      supabase,
      idempotencyKey: spendKey,
      amount: 1,
      note: data.title || "Studio master generation",
    });
  } catch (error) {
    if (error instanceof InsufficientTokensError) {
      throw new CortexGateError(
        1,
        402,
        error.message || "402 Insufficient token balance or atomic lock failed.",
      );
    }
    throw error;
  }

  // Open processing vault row NOW — Gate 3 identity binding starts here.
  let vaultId = data.vaultId ?? null;
  try {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    vaultId = await persistUserVault(admin, userId, {
      id: vaultId ?? undefined,
      title: data.title || "Untitled Track",
      style: genre,
      status: "processing",
    });
  } catch (error) {
    if (!tokenAuth.bypassed) {
      const { refundGenerationToken } = await import("@/lib/generation-tokens.server");
      await refundGenerationToken({
        userId,
        amount: 1,
        spendIdempotencyKey: spendKey,
        note: `Refund: cortex Gate 1 vault open failed [${input.correlationId}]`,
      }).catch(() => undefined);
    }
    throw new CortexGateError(
      1,
      500,
      error instanceof Error
        ? error.message
        : "Could not open profile-bound vault row.",
    );
  }

  return {
    userId,
    supabase,
    admin,
    data,
    spendKey,
    runKey,
    vaultId,
    tokenAuth,
  };
}

async function cortexGate2Enqueue(input: {
  userId: string;
  supabase: Db;
  admin: Db;
  data: GenerateEngineTrackInput;
  spendKey: string;
  runKey: string;
  tokenAuth: { bypassed: boolean; balance: number; alreadyApplied: boolean; idempotencyKey: string };
  vaultId: string | null;
  correlationId: string;
}): Promise<{ queueId: string; vaultId: string | null }> {
  const payloadForWorker: GenerateEngineTrackInput & { cortexCorrelationId?: string } = {
    ...input.data,
    vaultId: input.vaultId ?? undefined,
    idempotencyKey: input.runKey,
    cortexCorrelationId: input.correlationId,
  };

  const { data: inserted, error } = await input.admin
    .from("generation_queue")
    .insert({
      user_id: input.userId,
      vault_id: input.vaultId,
      prompt_payload: payloadForWorker as unknown as Json,
      status: "pending",
      spend_idempotency_key: input.spendKey,
    })
    .select("id, status")
    .maybeSingle();

  if (error || !inserted?.id) {
    if (error && /duplicate|unique/i.test(error.message)) {
      const { data: existing } = await input.admin
        .from("generation_queue")
        .select("id, vault_id, status")
        .eq("spend_idempotency_key", input.spendKey)
        .eq("user_id", input.userId)
        .maybeSingle();
      if (existing?.id) {
        void import("@/lib/generation-queue-worker.server")
          .then((m) => m.kickGenerationQueueWorker())
          .catch(() => undefined);
        return {
          queueId: existing.id,
          vaultId: existing.vault_id ?? input.vaultId,
        };
      }
    }
    throw new CortexGateError(
      2,
      500,
      "Queue ingestion failed. Tokens automatically refunded.",
    );
  }

  console.info("[cortex] Gate 2 queued", {
    correlationId: input.correlationId,
    userId: input.userId,
    queueId: inserted.id,
  });

  // INFORMANT: enqueue audit (fire-and-forget — never blocks Gate 2).
  void import("@/lib/PipelineInformant")
    .then(({ PipelineInformant }) =>
      PipelineInformant.recordTelemetry({
        eventType: "QUEUE_ENQUEUE",
        jobId: inserted.id,
        userId: input.userId,
        metadata: {
          correlationId: input.correlationId,
          vaultId: input.vaultId,
          tokenBypassed: input.tokenAuth.bypassed,
          balance: input.tokenAuth.balance,
        },
      }),
    )
    .catch(() => undefined);

  // Kick sequential worker — shared API key is drained one job at a time.
  void import("@/lib/generation-queue-worker.server")
    .then((m) => m.kickGenerationQueueWorker())
    .catch((err) => {
      console.warn(
        "[cortex] Gate 2 kick failed (poller will retry)",
        err instanceof Error ? err.message : err,
      );
    });

  return { queueId: inserted.id, vaultId: input.vaultId };
}

/** HTTP helper — maps CortexGateError / In-Gate rejection to Response. */
export function cortexErrorResponse(error: unknown): Response {
  if (error instanceof CortexGateError) {
    return Response.json(
      {
        error: error.message,
        gate: error.gate,
        statusCode: error.statusCode,
      },
      { status: error.statusCode },
    );
  }
  if (error instanceof InGateRejectionError || error instanceof UnauthorizedSessionError) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "401 In-Gate Rejection: Unauthorized user session detected.",
        gate: 1,
        statusCode: 401,
      },
      { status: 401 },
    );
  }
  const message =
    error instanceof Error ? error.message : "Generation cortex failed.";
  return Response.json({ error: message, statusCode: 500 }, { status: 500 });
}
