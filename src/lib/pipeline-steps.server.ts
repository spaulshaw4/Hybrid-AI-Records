/**
 * Five-stage studio pipeline: isolated providers, keys, and server telemetry.
 * Logs are for the terminal only — artist-facing errors stay vendor-neutral.
 */

export const PIPELINE_STEP_LOGS = {
  lyrics: ">>> [1/5: LYRICS] Gemini 2.5 on Replicate",
  music: ">>> [2/5: BASE AUDIO] AIMusicAPI Sonic v5",
  stems: ">>> [3/5: STEMS] Replicate Demucs separation",
  vocals: ">>> [4/5: VOCALS] Direct Fish.audio API dispatch",
  mastering: ">>> [5/5: MASTERING] Local Matchering + FFmpeg final pass",
} as const;

export type PipelineStepId = keyof typeof PIPELINE_STEP_LOGS;

const PIPELINE_PROVIDERS: Record<PipelineStepId, string> = {
  lyrics: "Replicate Gemini 2.5 Flash",
  music: "AIMusicAPI Sonic v5",
  stems: "Replicate Demucs",
  vocals: "Fish Audio",
  mastering: "Local Matchering",
};

export function logPipelineStep(step: PipelineStepId): void {
  console.log(PIPELINE_STEP_LOGS[step]);
}

export function logPipelineStepError(
  step: PipelineStepId,
  error: unknown,
  extra?: { status?: number; body?: string },
): void {
  const provider = PIPELINE_PROVIDERS[step];
  const message = error instanceof Error ? error.message : String(error ?? "");
  const status = extra?.status;
  const body = extra?.body ?? "";
  console.error(`>>> [${step.toUpperCase()}] ${provider} ERROR`, status ?? "", body || message);
}

function trimEnv(name: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Step 1 — lyrics. Isolated from ENGINE_API_KEY. */
export function lyricPipelineKey(): string | undefined {
  return trimEnv("LYRIC_ENGINE_API_KEY") || trimEnv("REPLICATE_API_KEY");
}

/** Step 2 — Sonic base audio. */
export function musicPipelineKey(): string | undefined {
  return (
    trimEnv("AIMUSICAPI_KEY") ||
    trimEnv("AI_MUSIC_API_KEY") ||
    trimEnv("MUSIC_API_KEY")
  );
}

/** Step 4 — Fish Audio direct TTS. Never Replicate. */
export function vocalPipelineKey(): string | undefined {
  return trimEnv("FISH_AUDIO_API_KEY") || trimEnv("FISH_API_KEY");
}

/** Steps 3–5 — Replicate stems, then local mastering. */
export function replicatePipelineKey(): string | undefined {
  return trimEnv("REPLICATE_API_KEY") || trimEnv("REPLICATE_API_TOKEN");
}
