/**
 * Proactive Flow Enforcer — perimeter middleware before token burn / queue locks.
 *
 * Anticipates bottlenecks (maintenance, queue ceiling, free-tier velocity)
 * and rejects upstream so zero tokens are spent on doomed requests.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { ContextFactory } from "@/lib/ExecutionContext";
import { PipelineActivatorSwitch } from "@/lib/PipelineActivatorSwitch";

export type FlowEnforcementResult = {
  allowed: boolean;
  reason?: string;
  mitigationAction?: string;
  httpStatus?: number;
};

const MAX_QUEUE_CAPACITY = Math.max(
  1,
  Number.parseInt(process.env.MAX_QUEUE_CAPACITY ?? "100", 10) || 100,
);
const FREE_TIER_VELOCITY_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.FREE_TIER_VELOCITY_LIMIT ?? "5", 10) || 5,
);
const FREE_TIER_VELOCITY_WINDOW_MS = Math.max(
  30_000,
  Number.parseInt(process.env.FREE_TIER_VELOCITY_WINDOW_MS ?? String(5 * 60 * 1000), 10) ||
    5 * 60 * 1000,
);

export class ProactiveFlowEnforcer {
  /**
   * Proactively evaluates system health and user velocity to enforce
   * flow control before tokens are burned or queue locks are acquired.
   */
  static async enforcePreFlightFlow(ctx: ExecutionContext): Promise<FlowEnforcementResult> {
    // 1. PROACTIVE CHECK: Master Activator Switch (cached + DB / env).
    const switchStatus = await PipelineActivatorSwitch.verifySystemArmed();
    if (!switchStatus.armed) {
      return {
        allowed: false,
        reason: "SYSTEM_IN_MAINTENANCE",
        mitigationAction: `Request rejected upstream. Zero tokens burned. State: ${switchStatus.state}`,
        httpStatus: 503,
      };
    }

    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (!admin) {
      // Without admin we cannot measure congestion; fail closed on production-like paths.
      return {
        allowed: false,
        reason: "SYSTEM_PROBE_UNAVAILABLE",
        mitigationAction: "Service role unavailable for proactive flow probes.",
        httpStatus: 503,
      };
    }

    // 2. PROACTIVE CHECK: Queue congestion backpressure.
    const { count: pendingCount, error: pendingError } = await admin
      .from("generation_queue")
      .select("*", { count: "exact", head: true })
      .eq("status", "pending");

    if (pendingError) {
      console.warn("[PROACTIVE FLOW] pending count failed", pendingError.message);
    } else if ((pendingCount ?? 0) >= MAX_QUEUE_CAPACITY) {
      return {
        allowed: false,
        reason: "QUEUE_CONGESTION_BACKPRESSURE",
        mitigationAction:
          "Queue capacity ceiling reached. Throttling incoming traffic proactively.",
        httpStatus: 429,
      };
    }

    // 3. PROACTIVE CHECK: Velocity throttling per user tier (free).
    if (ctx.tier === "free") {
      const windowStart = new Date(Date.now() - FREE_TIER_VELOCITY_WINDOW_MS).toISOString();
      const { count: recentUserJobs, error: velocityError } = await admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("user_id", ctx.userId)
        .gte("created_at", windowStart);

      if (velocityError) {
        console.warn("[PROACTIVE FLOW] velocity probe failed", velocityError.message);
      } else if ((recentUserJobs ?? 0) >= FREE_TIER_VELOCITY_LIMIT) {
        return {
          allowed: false,
          reason: "USER_VELOCITY_THROTTLE",
          mitigationAction:
            "Free tier generation rate limit reached. Please wait before submitting new tracks.",
          httpStatus: 429,
        };
      }
    }

    return { allowed: true };
  }
}

/**
 * In-Gate style helper: mint CTX → enforce → green-light for token burn / queue.
 */
export async function handleIngatePreflight(input: {
  userId: string;
  tier?: "free" | "pro" | "enterprise";
  correlationId?: string;
}): Promise<
  | {
      status: 200;
      proceedToQueue: true;
      context: ExecutionContext;
    }
  | {
      status: 429 | 503;
      proceedToQueue: false;
      error: string;
      message: string;
    }
> {
  const tempCtx = ContextFactory.create(input.userId, input.tier ?? "free", "in-gate", {
    requestId: input.correlationId,
  });
  const enforcement = await ProactiveFlowEnforcer.enforcePreFlightFlow(tempCtx);

  try {
    const { TelemetryAlignment } = await import("@/lib/TelemetryAlignment");
    TelemetryAlignment.emit(tempCtx, {
      eventType: "PREFLIGHT_EVALUATION",
      status: enforcement.allowed ? "SUCCESS" : "FAULT",
      details: {
        allowed: enforcement.allowed,
        reason: enforcement.reason ?? null,
        httpStatus: enforcement.httpStatus ?? (enforcement.allowed ? 200 : 429),
      },
    });
  } catch {
    /* never block ingress */
  }

  if (!enforcement.allowed) {
    return {
      status: (enforcement.httpStatus === 503 ? 503 : 429) as 429 | 503,
      proceedToQueue: false,
      error: enforcement.reason ?? "FLOW_ENFORCEMENT_REJECTED",
      message: enforcement.mitigationAction ?? "Request rejected by proactive flow enforcer.",
    };
  }
  return {
    status: 200,
    proceedToQueue: true,
    context: tempCtx,
  };
}
