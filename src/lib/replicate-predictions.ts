/**
 * Replicate prediction create routes.
 *
 * Official models (MiniMax, ElevenLabs Music) accept
 * POST /v1/models/{owner}/{name}/predictions.
 * Community models (ACE-Step, Demucs, …) 404 on that path — Replicate's
 * documented error is "The requested resource could not be found."
 * Those must be created with POST /v1/predictions and a version hash.
 */

export const REPLICATE_COMMUNITY_PREDICTIONS_PATH = "/predictions";

/** Cheapest GPU SKU that still runs Demucs / similar audio models. */
export const REPLICATE_COST_EFFECTIVE_GPU = "gpu-t4";

/**
 * Server-side Cancel-After ceiling for Replicate predictions.
 * Demucs needs 3–5 minutes for GPU cold-start + separation; a tight value
 * (e.g. 60s) marks the job Aborted on Replicate before polling can finish.
 */
export const REPLICATE_PREDICTION_TIMEOUT_MS = 300_000;

/** Gate 4 Demucs budget — Cancel-After + local poll must cover cold starts. */
export const DEMUCS_PREDICTION_TIMEOUT_MS = 300_000;

/**
 * Replicate headers for a prediction create.
 *
 * `Prefer: wait` holds the HTTP request open for a sync result, but a long hold
 * is fragile: if the connection drops, Replicate sees the client disconnect and
 * marks the prediction Aborted. Ask for only a brief wait and let the caller's
 * poll loop track the rest. `Cancel-After` is the server-side kill switch.
 */
export function replicateRunHeaders(
  timeoutMs = REPLICATE_PREDICTION_TIMEOUT_MS,
): Record<string, string> {
  const seconds = Math.max(5, Math.round(timeoutMs / 1000));
  return {
    "Cancel-After": `${seconds}s`,
    Prefer: "wait=5",
  };
}

export function officialModelPredictionsPath(model: `${string}/${string}`): string {
  return `/models/${model}/predictions`;
}

export function communityPredictionBody(
  version: string,
  input: Record<string, unknown>,
  options: { hardware?: string } = {},
): { version: string; input: Record<string, unknown>; hardware?: string } {
  return {
    version,
    input,
    ...(options.hardware ? { hardware: options.hardware } : {}),
  };
}
