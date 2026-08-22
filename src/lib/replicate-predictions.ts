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

export function officialModelPredictionsPath(model: `${string}/${string}`): string {
  return `/models/${model}/predictions`;
}

export function communityPredictionBody(
  version: string,
  input: Record<string, unknown>,
): { version: string; input: Record<string, unknown> } {
  return { version, input };
}
