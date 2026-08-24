/**
 * Pipeline mode: production short path vs full stem pipeline.
 *
 * Production default — Gate 1 (AIMusicAPI) → Gate 2 (Supabase vault) → Gate 6
 * (FFmpeg master from the Gate 2 CDN URL). Gates 3–5 stay in the codebase and
 * run only when the stem pipeline toggle is on.
 *
 * Enable CWALO / Demucs / RVC (Gates 3–5):
 *   HYBRID_ENABLE_STEM_PIPELINE=1
 */
import { isDevRuntime } from "@/lib/supabase-env.server";

function trimEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

/**
 * True when Gates 3 (CWALO), 4 (Demucs), and 5 (RVC/Fish) should run.
 * Explicit `0`/`false`/`off` always disables; `1`/`true`/`on` always enables.
 * Unset defaults to **off** (production short path).
 */
export function isStemPipelineEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env.HYBRID_ENABLE_STEM_PIPELINE ?? env.PIPELINE_ENABLE_STEMS)?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return false;
}

/** Human label for logs / SSE diagnostics. */
export function pipelineModeLabel(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  if (isStemPipelineEnabled(env)) {
    return isDevRuntime()
      ? "full stem pipeline (Gates 1–6, HYBRID_ENABLE_STEM_PIPELINE)"
      : "full stem pipeline (Gates 1–6)";
  }
  return "production short path (Gate 1 → 2 → 6)";
}
