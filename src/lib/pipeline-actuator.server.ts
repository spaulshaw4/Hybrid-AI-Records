/**
 * Pipeline Actuator — health readouts + administrative control hooks.
 *
 * GET-style health: queue backlog depth, processing count, worker status.
 * Commands: FLUSH_STUCK_JOBS (force-fail + refund via End-Gate).
 */

import { PipelineInformant } from "@/lib/PipelineInformant";

export const ACTUATOR_STUCK_JOB_MS = Math.max(
  60_000,
  Number.parseInt(process.env.ACTUATOR_STUCK_JOB_MS ?? String(30 * 60 * 1000), 10) ||
    30 * 60 * 1000,
);

export type ActuatorHealth = {
  status: "HEALTHY" | "DEGRADED";
  actuator: "ONLINE" | "ERROR";
  /** Algorithmic ActuatorMonitor readout (threshold logic, zero AI). */
  evaluation?: {
    status: "OPTIMAL" | "CONGESTED" | "CRITICAL";
    recommendedAction: string;
    metricsSnapshot: { pending: number; processing: number; failed: number };
    evaluatedAt: string;
  };
  metrics?: {
    pendingJobs: number;
    processingJobs: number;
    failedRecent?: number;
    worker: {
      enabled: boolean;
      installed: boolean;
      running: boolean;
      lastUpstreamStartAt: number;
    };
    stuckThresholdMs: number;
    timestamp: string;
  };
  error?: string;
};

export type ActuatorCommandResult = {
  success: boolean;
  message: string;
  command?: string;
  stuckCount?: number;
  flushed?: Array<{ jobId: string; userId: string }>;
  state?: string;
  error?: string;
};

function timingSafeEqualString(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let equal = left.length === right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) equal = false;
  }
  return equal;
}

/** Validates ADMIN_ACTUATOR_SECRET from body, Bearer, or `?secret=` / `?token=`. */
export function authorizeActuatorCommand(input: {
  request: Request;
  bodySecret?: string | null;
}): { ok: true } | { ok: false; status: number; error: string } {
  const expected = process.env.ADMIN_ACTUATOR_SECRET?.trim();
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: "Actuator commands disabled: ADMIN_ACTUATOR_SECRET is not configured.",
    };
  }

  const header = input.request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const url = new URL(input.request.url);
  const querySecret =
    url.searchParams.get("secret") ?? url.searchParams.get("token") ?? "";
  const provided = (input.bodySecret ?? "").trim() || bearer || querySecret;

  if (!provided || !timingSafeEqualString(provided, expected)) {
    return { ok: false, status: 401, error: "Unauthorized actuator command." };
  }
  return { ok: true };
}

export async function readActuatorHealth(): Promise<ActuatorHealth> {
  try {
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (!admin) {
      return {
        status: "DEGRADED",
        actuator: "ERROR",
        error: "Supabase service role unavailable.",
      };
    }

    const [{ count: pendingCount, error: pendingError }, { count: processingCount, error: processingError }, { count: failedCount, error: failedError }] =
      await Promise.all([
        admin
          .from("generation_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "pending"),
        admin
          .from("generation_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "processing"),
        admin
          .from("generation_queue")
          .select("*", { count: "exact", head: true })
          .eq("status", "failed"),
      ]);

    if (pendingError || processingError || failedError) {
      throw new Error(
        pendingError?.message ||
          processingError?.message ||
          failedError?.message ||
          "Queue probe failed",
      );
    }

    let worker = {
      enabled: true,
      installed: false,
      running: false,
      lastUpstreamStartAt: 0,
    };
    try {
      const mod = await import("@/lib/generation-queue-worker.server");
      worker = mod.getGenerationQueueWorkerStatus();
    } catch {
      /* worker module optional at probe time */
    }

    const { ActuatorMonitor } = await import("@/lib/ActuatorMonitor");
    const metrics = {
      pendingJobs: pendingCount ?? 0,
      processingJobs: processingCount ?? 0,
      failedJobCount: failedCount ?? 0,
    };
    const evaluation = ActuatorMonitor.evaluateHealth(metrics);

    // Operational trigger: CRITICAL → auto MAINTENANCE via Activator Switch.
    let safeguard: { tripped: boolean; actionTaken?: string } | undefined;
    try {
      const { PipelineTriggerOrchestrator } = await import(
        "@/lib/PipelineTriggerOrchestrator"
      );
      const result = await PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards(metrics);
      safeguard = {
        tripped: result.tripped,
        ...(result.tripped ? { actionTaken: result.actionTaken } : {}),
      };
    } catch (err) {
      console.warn(
        "[actuator] safeguard evaluation failed",
        err instanceof Error ? err.message : err,
      );
    }

    const health: ActuatorHealth = {
      status: evaluation.status === "CRITICAL" ? "DEGRADED" : "HEALTHY",
      actuator: "ONLINE",
      evaluation,
      metrics: {
        pendingJobs: pendingCount ?? 0,
        processingJobs: processingCount ?? 0,
        failedRecent: failedCount ?? 0,
        worker,
        stuckThresholdMs: ACTUATOR_STUCK_JOB_MS,
        timestamp: new Date().toISOString(),
      },
      ...(safeguard?.tripped
        ? {
            error: `Circuit breaker tripped: ${safeguard.actionTaken ?? "MAINTENANCE_ENGAGED"}`,
          }
        : {}),
    };

    PipelineInformant.emit({
      eventType: "ACTUATOR_HEALTH",
      metadata: {
        pendingJobs: health.metrics?.pendingJobs ?? 0,
        processingJobs: health.metrics?.processingJobs ?? 0,
        failedJobs: failedCount ?? 0,
        evaluationStatus: evaluation.status,
        recommendedAction: evaluation.recommendedAction,
        workerEnabled: worker.enabled,
        safeguardTripped: Boolean(safeguard?.tripped),
        safeguardAction: safeguard?.actionTaken ?? null,
      },
    });

    return health;
  } catch (err) {
    return {
      status: "DEGRADED",
      actuator: "ERROR",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Force-fail jobs stuck in `processing` longer than the threshold and refund
 * via End-Gate so tokens are returned to the original owners.
 */
export async function flushStuckGenerationJobs(options?: {
  olderThanMs?: number;
}): Promise<ActuatorCommandResult> {
  const olderThanMs = options?.olderThanMs ?? ACTUATOR_STUCK_JOB_MS;
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();

  const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = tryGetSupabaseAdmin();
  if (!admin) {
    return {
      success: false,
      message: "Actuator flush aborted: service role unavailable.",
      error: "service_role_missing",
    };
  }

  const { data: stuckJobs, error } = await admin
    .from("generation_queue")
    .select("id, user_id, vault_id, spend_idempotency_key, updated_at, started_at")
    .eq("status", "processing")
    .lt("updated_at", cutoff);

  if (error) {
    return {
      success: false,
      message: "Actuator flush query failed.",
      error: error.message,
    };
  }

  const rows = stuckJobs ?? [];
  const flushed: Array<{ jobId: string; userId: string }> = [];
  const { EndGateDispatcher } = await import("@/lib/EndGateDispatcher");

  for (const row of rows) {
    if (!row?.id || !row?.user_id) continue;
    await EndGateDispatcher.handleDeliveryFailure({
      jobId: row.id,
      userId: row.user_id,
      errorMessage: `Actuator FLUSH_STUCK_JOBS: processing longer than ${Math.round(olderThanMs / 60000)}m (updated_at < ${cutoff}).`,
      spendIdempotencyKey: row.spend_idempotency_key,
      vaultId: row.vault_id,
    });
    flushed.push({ jobId: row.id, userId: row.user_id });

    PipelineInformant.emit({
      eventType: "ACTUATOR_FLUSH",
      jobId: row.id,
      userId: row.user_id,
      metadata: {
        command: "FLUSH_STUCK_JOBS",
        cutoff,
        spendKeyPresent: Boolean(row.spend_idempotency_key),
      },
    });

    if (row.spend_idempotency_key) {
      PipelineInformant.emit({
        eventType: "TOKEN_REFUND",
        jobId: row.id,
        userId: row.user_id,
        metadata: {
          reason: "actuator_flush_stuck",
          spendIdempotencyKey: row.spend_idempotency_key,
        },
      });
    }
  }

  // Nudge the worker so pending backlog can resume after a flush.
  try {
    const { kickGenerationQueueWorker } = await import("@/lib/generation-queue-worker.server");
    kickGenerationQueueWorker();
  } catch {
    /* ignore */
  }

  return {
    success: true,
    command: "FLUSH_STUCK_JOBS",
    message: `Actuator executed flush. Inspected and settled ${flushed.length} stuck job(s).`,
    stuckCount: flushed.length,
    flushed,
  };
}

export async function executeActuatorCommand(
  command: string,
  options?: { state?: string; secretKey?: string },
): Promise<ActuatorCommandResult> {
  if (command === "FLUSH_STUCK_JOBS") {
    return flushStuckGenerationJobs();
  }
  if (command === "KICK_WORKER") {
    try {
      const { kickGenerationQueueWorker, getGenerationQueueWorkerStatus } = await import(
        "@/lib/generation-queue-worker.server"
      );
      kickGenerationQueueWorker();
      return {
        success: true,
        command: "KICK_WORKER",
        message: "Actuator kicked generation queue worker.",
        ...({ worker: getGenerationQueueWorkerStatus() } as object),
      } as ActuatorCommandResult;
    } catch (err) {
      return {
        success: false,
        command: "KICK_WORKER",
        message: "Could not kick worker.",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (
    command === "SET_PIPELINE_STATE" ||
    command === "SET_ARMED" ||
    command === "SET_MAINTENANCE" ||
    command === "SET_DISABLED"
  ) {
    try {
      const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
      const mapped =
        command === "SET_ARMED"
          ? "ARMED"
          : command === "SET_MAINTENANCE"
            ? "MAINTENANCE"
            : command === "SET_DISABLED"
              ? "DISABLED"
              : options?.state;
      if (!mapped) {
        return {
          success: false,
          command,
          message: "Missing state. Use ARMED | MAINTENANCE | DISABLED.",
          error: "missing_state",
        };
      }
      const secret = options?.secretKey ?? process.env.ADMIN_ACTUATOR_SECRET ?? "";
      const state = await PipelineActivatorSwitch.setSystemState(
        mapped as "ARMED" | "MAINTENANCE" | "DISABLED",
        secret,
      );
      return {
        success: true,
        command,
        state,
        message: `Activator switch set to ${state}.`,
      };
    } catch (err) {
      return {
        success: false,
        command,
        message: err instanceof Error ? err.message : "Activator switch failed.",
        error: "activator_switch_failed",
      };
    }
  }
  return {
    success: false,
    message: "Unknown actuator command.",
    error: "unknown_command",
  };
}
