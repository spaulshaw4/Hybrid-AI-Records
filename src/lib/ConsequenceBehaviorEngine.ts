/**
 * Consequence Behavior Engine — structural adaptation from execution outcomes.
 *
 * Measures environmental results (failure, timeout duration, stable success)
 * and updates behavioral_throttle_multiplier so the next cycle compensates.
 */

import { PipelineInformant } from "@/lib/PipelineInformant";

export type ConsequenceState = "FAILURE_SPIKE" | "STABLE_OPERATION" | "SLOW_SUCCESS";

const CONFIG_KEY = "behavioral_throttle_multiplier";

let cachedMultiplier = 1;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5_000;
let consecutiveFailures = 0;

export class ConsequenceBehaviorEngine {
  /** In-process multiplier for hot-path throttle math (refreshed from DB). */
  static getCachedThrottleMultiplier(): number {
    return clampMultiplier(cachedMultiplier);
  }

  static async refreshThrottleMultiplier(): Promise<number> {
    const now = Date.now();
    if (now - cacheLoadedAt < CACHE_TTL_MS && cacheLoadedAt > 0) {
      return clampMultiplier(cachedMultiplier);
    }
    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return clampMultiplier(cachedMultiplier);
      const { data } = await admin
        .from("system_config")
        .select("value")
        .eq("key", CONFIG_KEY)
        .maybeSingle();
      const parsed = Number.parseFloat(String(data?.value ?? "1"));
      cachedMultiplier = Number.isFinite(parsed) ? parsed : 1;
      cacheLoadedAt = now;
    } catch {
      /* keep last known */
    }
    return clampMultiplier(cachedMultiplier);
  }

  /**
   * Evaluates the consequence of a generation run and adapts the next cycle.
   */
  static async adaptToConsequences(input: {
    jobId: string;
    userId?: string | null;
    success: boolean;
    executionDurationMs: number;
    errorMessage?: string;
  }): Promise<{ state: ConsequenceState; throttleMultiplier: number }> {
    const duration = Math.max(0, Math.trunc(input.executionDurationMs || 0));

    if (!input.success) {
      consecutiveFailures += 1;
      console.warn(
        `[CONSEQUENCE DETECTED] Job ${input.jobId} failed. Duration: ${duration}ms. Error: ${input.errorMessage ?? "unknown"}`,
      );

      await PipelineInformant.recordTelemetry({
        eventType: "CONSEQUENCE_FAILURE_ADAPTATION",
        jobId: input.jobId,
        userId: input.userId ?? null,
        metadata: {
          duration,
          error: (input.errorMessage ?? "").slice(0, 500),
          consecutiveFailures,
          systemActor: "00000000-0000-0000-0000-000000000000",
        },
      });

      const multiplier = await ConsequenceBehaviorEngine.enforceBehavioralCorrection(
        "FAILURE_SPIKE",
      );

      // Escalation: repeated failures feed Actuator/Automation safeguards.
      if (consecutiveFailures >= 5) {
        try {
          const { PipelineAutomationEngine } = await import("@/lib/PipelineAutomationEngine");
          await PipelineAutomationEngine.evaluateAndEnforceSystemState();
        } catch {
          /* never block the worker */
        }
      }

      return { state: "FAILURE_SPIKE", throttleMultiplier: multiplier };
    }

    consecutiveFailures = 0;
    const slow = duration > 120_000;
    const state: ConsequenceState = slow ? "SLOW_SUCCESS" : "STABLE_OPERATION";
    const multiplier = await ConsequenceBehaviorEngine.enforceBehavioralCorrection(
      slow ? "FAILURE_SPIKE" : "STABLE_OPERATION",
    );

    if (slow) {
      await PipelineInformant.recordTelemetry({
        eventType: "CONSEQUENCE_FAILURE_ADAPTATION",
        jobId: input.jobId,
        userId: input.userId ?? null,
        metadata: {
          duration,
          reason: "slow_success_backoff",
          consecutiveFailures: 0,
        },
      });
    }

    return { state, throttleMultiplier: multiplier };
  }

  static async enforceBehavioralCorrection(
    state: "FAILURE_SPIKE" | "STABLE_OPERATION",
  ): Promise<number> {
    // Soft ramp: spikes jump toward 2.5; stable decays toward 1.0.
    const target = state === "FAILURE_SPIKE" ? 2.5 : 1.0;
    const current = clampMultiplier(cachedMultiplier);
    const next =
      state === "FAILURE_SPIKE"
        ? Math.min(2.5, Math.max(target, current * 1.25))
        : Math.max(1.0, current * 0.9 + target * 0.1);

    cachedMultiplier = clampMultiplier(next);
    cacheLoadedAt = Date.now();

    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return cachedMultiplier;

      await admin.from("system_config").upsert(
        {
          key: CONFIG_KEY,
          value: String(cachedMultiplier),
          updated_at: new Date().toISOString(),
          updated_by: "consequence-behavior-engine",
        },
        { onConflict: "key" },
      );
    } catch (err) {
      console.error(
        "[CONSEQUENCE] throttle upsert failed",
        err instanceof Error ? err.message : err,
      );
    }

    return cachedMultiplier;
  }

  /** Test helper */
  static resetForTests(multiplier = 1): void {
    cachedMultiplier = multiplier;
    cacheLoadedAt = 0;
    consecutiveFailures = 0;
  }
}

function clampMultiplier(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0.75, Number(value.toFixed(3))));
}
