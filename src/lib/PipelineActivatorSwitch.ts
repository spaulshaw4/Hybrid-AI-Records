/**
 * Pipeline Activator Switch — master arm / maintenance / disable interlock.
 *
 * Cached for CACHE_TTL_MS so ingress stays fast; persisted in system_config.
 */

import type { Database } from "@/integrations/supabase/types";

export type SystemState = "ARMED" | "MAINTENANCE" | "DISABLED";

const VALID_STATES = new Set<SystemState>(["ARMED", "MAINTENANCE", "DISABLED"]);

function normalizeState(raw: unknown): SystemState | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toUpperCase() as SystemState;
  return VALID_STATES.has(value) ? value : null;
}

export class ActivatorSwitchRejectionError extends Error {
  readonly statusCode = 401 as const;

  constructor(message: string) {
    super(message);
    this.name = "ActivatorSwitchRejectionError";
  }
}

export class PipelineActivatorSwitch {
  private static cachedState: SystemState = "ARMED";
  private static lastCheckTime = 0;
  private static CACHE_TTL_MS = Math.max(
    1_000,
    Number.parseInt(process.env.PIPELINE_ACTIVATOR_CACHE_MS ?? "10000", 10) || 10_000,
  );

  /** Test / actuator helper — clears TTL cache immediately. */
  static bustCache(): void {
    this.lastCheckTime = 0;
  }

  static getCachedState(): SystemState {
    return this.cachedState;
  }

  /**
   * Master safety interlock: Checks if the pipeline is globally armed for generation.
   */
  static async verifySystemArmed(): Promise<{
    armed: boolean;
    state: SystemState;
    message: string;
  }> {
    const now = Date.now();
    if (now - this.lastCheckTime < this.CACHE_TTL_MS) {
      return {
        armed: this.cachedState === "ARMED",
        state: this.cachedState,
        message: `System is currently ${this.cachedState}.`,
      };
    }

    // Env override wins when set (ops kill-switch without DB round-trip).
    const envState = normalizeState(process.env.PIPELINE_MASTER_STATE);
    if (envState) {
      this.cachedState = envState;
      this.lastCheckTime = now;
      return {
        armed: envState === "ARMED",
        state: envState,
        message: `System active state resolved as: ${envState} (env)`,
      };
    }

    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (admin) {
        const { data, error } = await admin
          .from("system_config")
          .select("value")
          .eq("key", "pipeline_master_state")
          .maybeSingle();

        if (!error && data?.value) {
          const parsed = normalizeState(data.value);
          if (parsed) this.cachedState = parsed;
        }
      }
    } catch (err) {
      console.warn(
        "[activator-switch] state fetch failed; using cache",
        err instanceof Error ? err.message : err,
      );
    }

    this.lastCheckTime = now;
    return {
      armed: this.cachedState === "ARMED",
      state: this.cachedState,
      message: `System active state resolved as: ${this.cachedState}`,
    };
  }

  /**
   * Flips the master activator switch instantly (requires ADMIN_ACTUATOR_SECRET).
   */
  static async setSystemState(newState: SystemState, adminSecret: string): Promise<SystemState> {
    const expected = process.env.ADMIN_ACTUATOR_SECRET?.trim();
    if (!expected || adminSecret !== expected) {
      throw new ActivatorSwitchRejectionError(
        "Activator Switch Rejection: Unauthorized state change attempt.",
      );
    }

    const state = normalizeState(newState);
    if (!state) {
      throw new ActivatorSwitchRejectionError(
        "Activator Switch Rejection: Invalid system state.",
      );
    }

    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (!admin) {
      // Still arm local cache so ops can flip without DB in emergency local mode.
      this.cachedState = state;
      this.lastCheckTime = Date.now();
      console.warn("[activator-switch] no service role — cache-only state flip", state);
      return state;
    }

    const row: Database["public"]["Tables"]["system_config"]["Insert"] = {
      key: "pipeline_master_state",
      value: state,
      updated_at: new Date().toISOString(),
      updated_by: "actuator",
    };

    const { error } = await admin.from("system_config").upsert(row, { onConflict: "key" });
    if (error) {
      throw new Error(`Activator Switch write failed: ${error.message}`);
    }

    this.cachedState = state;
    this.lastCheckTime = Date.now();
    return state;
  }
}
