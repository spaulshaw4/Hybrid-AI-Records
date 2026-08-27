/**
 * Reactive Corement Placement Engine — downstream routing from live pressure.
 *
 * Reads Activator state + behavioral throttle consequences and chooses a
 * logical execution cluster / priority before the worker burns upstream time.
 * Closes the loop with ProactiveFlowEnforcer (perimeter) and Consequence /
 * Sentinel (self-healing).
 */

import { PipelineInformant } from "@/lib/PipelineInformant";

export type PlacementPriority = "HIGH" | "NORMAL" | "DEGRADED_FALLBACK";

export type PlacementDirective = {
  targetNodeCluster: string;
  allocationPriority: PlacementPriority;
  dynamicWeightScale: number;
  /** True when the claim must be released without upstream execution. */
  deferExecution: boolean;
};

const PRESSURE_THRESHOLD = Math.max(
  1.01,
  Number.parseFloat(process.env.REACTIVE_PLACEMENT_PRESSURE_THRESHOLD ?? "1.5") || 1.5,
);

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

export class ReactiveCorementPlacementEngine {
  /**
   * Reactively evaluates live system telemetry and worker health consequences
   * to determine optimal core placement and workload routing on the fly.
   */
  static async evaluateAndPlaceWorkload(
    jobId: string,
    userTier: string,
    userId?: string | null,
  ): Promise<PlacementDirective> {
    const tier = normalizeTier(userTier);
    let throttleMultiplier = 1;
    let systemState = "ARMED";

    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (admin) {
        const { data: configRows } = await admin
          .from("system_config")
          .select("key, value")
          .in("key", ["behavioral_throttle_multiplier", "pipeline_master_state"]);

        const configMap = new Map(
          (configRows ?? []).map((row) => [String(row.key), String(row.value ?? "")]),
        );
        const parsed = Number.parseFloat(
          configMap.get("behavioral_throttle_multiplier") || "1.0",
        );
        throttleMultiplier = Number.isFinite(parsed) ? parsed : 1;
        systemState = (configMap.get("pipeline_master_state") || "ARMED").toUpperCase();
      }
    } catch {
      /* fall through to Activator + Consequence caches */
    }

    // Prefer Activator Switch (env override + cache) when DB probe is stale.
    try {
      const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
      const status = await PipelineActivatorSwitch.verifySystemArmed();
      systemState = status.state;
    } catch {
      /* keep DB/env guess */
    }

    try {
      const { ConsequenceBehaviorEngine } = await import("@/lib/ConsequenceBehaviorEngine");
      const cached = ConsequenceBehaviorEngine.getCachedThrottleMultiplier();
      if (Number.isFinite(cached) && cached > 0) {
        throttleMultiplier = Math.max(throttleMultiplier, cached);
      }
    } catch {
      /* ignore */
    }

    let directive: PlacementDirective;

    if (systemState === "MAINTENANCE" || systemState === "DISABLED") {
      directive = {
        targetNodeCluster: "maintenance-quarantine-node",
        allocationPriority: "DEGRADED_FALLBACK",
        dynamicWeightScale: 0,
        deferExecution: true,
      };
    } else if (throttleMultiplier > PRESSURE_THRESHOLD) {
      if (tier === "enterprise" || tier === "pro") {
        directive = {
          targetNodeCluster: "priority-isolated-grid",
          allocationPriority: "HIGH",
          dynamicWeightScale: throttleMultiplier,
          deferExecution: false,
        };
      } else {
        directive = {
          targetNodeCluster: "backpressure-queuing-pool",
          allocationPriority: "DEGRADED_FALLBACK",
          dynamicWeightScale: throttleMultiplier,
          deferExecution: false,
        };
      }
    } else if (tier === "enterprise") {
      directive = {
        targetNodeCluster: "dedicated-enterprise-grid",
        allocationPriority: "HIGH",
        dynamicWeightScale: throttleMultiplier,
        deferExecution: false,
      };
    } else {
      directive = {
        targetNodeCluster: "primary-execution-grid",
        allocationPriority: "NORMAL",
        dynamicWeightScale: throttleMultiplier,
        deferExecution: false,
      };
    }

    await PipelineInformant.recordTelemetry({
      eventType: "REACTIVE_PLACEMENT_ROUTING",
      jobId,
      userId: userId?.trim() || SYSTEM_ACTOR,
      metadata: {
        targetCluster: directive.targetNodeCluster,
        priority: directive.allocationPriority,
        throttleMultiplier,
        dynamicWeightScale: directive.dynamicWeightScale,
        deferExecution: directive.deferExecution,
        userTier: tier,
        systemState,
        systemActor: SYSTEM_ACTOR,
      },
    });

    return directive;
  }

  /**
   * Bias the adaptive upstream gap from placement priority / weight scale.
   */
  static applyThrottleBias(baseThrottleMs: number, directive: PlacementDirective): number {
    const base = Math.max(0, Math.trunc(baseThrottleMs || 0));
    const weight = Number.isFinite(directive.dynamicWeightScale)
      ? Math.max(0, directive.dynamicWeightScale)
      : 1;

    if (directive.deferExecution || weight <= 0) {
      return base * 4;
    }

    if (directive.allocationPriority === "HIGH") {
      return Math.max(0, Math.floor(base / Math.min(2, Math.max(1, weight))));
    }

    if (directive.allocationPriority === "DEGRADED_FALLBACK") {
      return Math.floor(base * Math.max(1.25, weight));
    }

    return Math.floor(base * Math.max(0.85, Math.min(weight, 1.5)));
  }

  /** Release a claimed row back to pending (maintenance / quarantine). */
  static async releaseClaimToPending(jobId: string): Promise<boolean> {
    const id = jobId?.trim();
    if (!id) return false;
    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return false;
      const { error } = await admin
        .from("generation_queue")
        .update({
          status: "pending",
          started_at: null,
          error_message: "Deferred by reactive placement (maintenance quarantine).",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("status", "processing");
      if (error) {
        console.error("[REACTIVE PLACEMENT] release failed", error.message);
        return false;
      }
      return true;
    } catch (err) {
      console.error(
        "[REACTIVE PLACEMENT] release failed",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }
}

function normalizeTier(raw?: string): "free" | "pro" | "enterprise" {
  const t = String(raw ?? "free").toLowerCase().trim();
  if (t === "enterprise" || t === "admin") return "enterprise";
  if (t === "pro" || t === "premium") return "pro";
  return "free";
}
