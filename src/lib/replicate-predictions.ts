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

/** Hard ceiling for a single stem/audio prediction so GPU time cannot hang. */
export const REPLICATE_PREDICTION_TIMEOUT_MS = 120_000;

/**
 * Replicate headers that cap a prediction's lifetime and wait up to 60s
 * for a sync result. `Cancel-After` is the server-side kill switch.
 */
export function replicateRunHeaders(
  timeoutMs = REPLICATE_PREDICTION_TIMEOUT_MS,
): Record<string, string> {
  const seconds = Math.max(5, Math.round(timeoutMs / 1000));
  return {
    "Cancel-After": `${seconds}s`,
    Prefer: "wait=60",
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
