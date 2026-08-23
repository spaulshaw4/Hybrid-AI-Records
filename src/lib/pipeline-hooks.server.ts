/**
 * Soft lifecycle hooks for the 6-gate pipeline.
 * Telemetry / logging / DB status writes must never abort core gate work or
 * prevent finally cleanup (lock release + temp purge).
 */

import type { GateStage, GateTelemetry } from "@/types/pipeline";
import { bumpTelemetry, recordFallback } from "@/types/pipeline";

function hookErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

/**
 * Run a side-effect hook. Failures are logged and swallowed.
 */
export async function runSafeHook(
  label: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.warn(`[Hook Soft-Fail] ${label}: ${hookErrorMessage(error)}`);
  }
}

/** Synchronous variant for console / in-memory telemetry bumps. */
export function runSafeHookSync(label: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    console.warn(`[Hook Soft-Fail] ${label}: ${hookErrorMessage(error)}`);
  }
}

export type GateHookContext = {
  trackId: string;
  gate: 1 | 2 | 3 | 4 | 5 | 6;
  stage: GateStage;
};

export async function beforeGate(
  ctx: GateHookContext,
  extra?: () => void | Promise<void>,
): Promise<void> {
  await runSafeHook(`beforeGate ${ctx.gate}/6`, async () => {
    console.log(`[Gate ${ctx.gate}/6] Starting — track=${ctx.trackId} stage=${ctx.stage}`);
    if (extra) await extra();
  });
}

export async function afterGate(
  ctx: GateHookContext,
  detail?: string,
  extra?: () => void | Promise<void>,
): Promise<void> {
  await runSafeHook(`afterGate ${ctx.gate}/6`, async () => {
    console.log(
      `[Gate ${ctx.gate}/6] Finished — track=${ctx.trackId}${detail ? ` ${detail}` : ""}`,
    );
    if (extra) await extra();
  });
}

/** Soft telemetry bump — returns previous telemetry if the bump throws. */
export function safeBumpTelemetry(
  telemetry: GateTelemetry,
  gate: number,
  stage: GateStage,
): GateTelemetry {
  try {
    return bumpTelemetry(telemetry, gate, stage);
  } catch (error) {
    console.warn(`[Hook Soft-Fail] bumpTelemetry Gate ${gate}: ${hookErrorMessage(error)}`);
    return telemetry;
  }
}

export function safeRecordFallback(telemetry: GateTelemetry, token: string): GateTelemetry {
  try {
    return recordFallback(telemetry, token);
  } catch (error) {
    console.warn(`[Hook Soft-Fail] recordFallback ${token}: ${hookErrorMessage(error)}`);
    return telemetry;
  }
}

/**
 * Best-effort track status transition. Never throws into the pipeline.
 */
export async function safeUpdateTrackStatus(input: {
  trackId: string;
  userId: string;
  status: "processing" | "completed" | "failed";
  audioUrl?: string | null;
  reason?: string;
}): Promise<void> {
  await runSafeHook(`db status → ${input.status}`, async () => {
    if (input.status === "completed" && input.audioUrl) {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({
        taskId: input.trackId,
        userId: input.userId,
        audioUrl: input.audioUrl,
      });
      return;
    }
    if (input.status === "failed") {
      const { failGenerationTask } = await import("@/lib/engine-pipeline.server");
      await failGenerationTask({
        taskId: input.trackId,
        userId: input.userId,
        reason: input.reason ?? "pipeline failed",
      });
      return;
    }
    // processing — best-effort generation_tasks / user_vault update
    const { createEngineSupabaseClient } = await import("@/lib/engine-pipeline.server");
    const supabase = createEngineSupabaseClient();
    if (!supabase) return;
    const now = new Date().toISOString();
    await supabase
      .from("generation_tasks")
      .upsert(
        {
          id: input.trackId,
          user_id: input.userId,
          status: "processing",
          updated_at: now,
        } as never,
        { onConflict: "id" },
      )
      .then(({ error }) => {
        if (error) throw new Error(error.message);
      });
  });
}
