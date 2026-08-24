/**
 * Six runtime gates of a studio generate. Lyrics are written earlier by the
 * Co-Producer and arrive in the payload, so they sit outside the numbering.
 * Logs are for the terminal only — artist-facing errors stay vendor-neutral.
 */

export const PIPELINE_STEP_LOGS = {
  lyrics: ">>> [LYRICS] Gemini 2.5 on Replicate (Co-Producer)",
  music: ">>> [1/6: BASE GENERATION] AIMusicAPI chirp-v5",
  vault: ">>> [2/6: SUPABASE VAULT] Isolate Gate 1 audio to public HTTPS CDN",
  cwalo: ">>> [3/6: STRUCTURE] CWALO all-in-one music structure analysis",
  stems: ">>> [4/6: STEMS] Replicate Demucs separation",
  vocals: ">>> [5/6: VOCALS] Fish Audio Plus vocal synthesis",
  mastering: ">>> [6/6: MASTERING] Resemble Enhance + FFmpeg finish",
} as const;

export type PipelineStepId = keyof typeof PIPELINE_STEP_LOGS;

const PIPELINE_PROVIDERS: Record<PipelineStepId, string> = {
  lyrics: "Replicate Gemini 2.5 Flash",
  music: "AIMusicAPI chirp-v5",
  vault: "Supabase audio-vault",
  cwalo: "Replicate CWALO structure analysis",
  stems: "Replicate Demucs",
  vocals: "Fish Audio Plus",
  mastering: "Resemble Enhance + FFmpeg",
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

/** Lyrics / Gemini — isolated from hybrid REPLICATE_API_TOKEN. */
export function lyricPipelineKey(): string | undefined {
  return trimEnv("LYRIC_ENGINE_API_KEY") || trimEnv("ENGINE_API_KEY");
}

/** Gate 1 — Sonic base audio. */
export function musicPipelineKey(): string | undefined {
  return (
    trimEnv("AIMUSICAPI_KEY") ||
    trimEnv("AI_MUSIC_API_KEY") ||
    trimEnv("MUSIC_API_KEY")
  );
}

/** Gate 5 — Fish Audio direct TTS. Never Replicate. */
export function vocalPipelineKey(): string | undefined {
  return trimEnv("FISH_AUDIO_API_KEY") || trimEnv("FISH_API_KEY");
}

/** Gates 3–4 — Replicate CWALO + Demucs (hybrid1 token). */
export function replicatePipelineKey(): string | undefined {
  return trimEnv("REPLICATE_API_TOKEN") || trimEnv("REPLICATE_API_KEY");
}
