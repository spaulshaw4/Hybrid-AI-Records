/**
 * Replicate `fishaudio/ace-step-1.5` input builder.
 *
 * ACE-Step handles vocal arrangement and stems. Prompt is capped at 512
 * characters on the hosted model; lyrics carry structure tags.
 */

export const ACE_STEP_MODEL = "fishaudio/ace-step-1.5";
/**
 * ACE-Step is a community model. Replicate's `/models/{owner}/{name}/predictions`
 * route is official-models only and 404s here — create via `/predictions` with
 * a version hash instead (same pattern as Demucs stem separation).
 */
export const ACE_STEP_PREDICTIONS_PATH = "/predictions";
export const ACE_STEP_PROMPT_MAX = 512;
export const ACE_STEP_LYRICS_MAX = 4096;
export const ACE_STEP_DURATION_MIN = 10;
export const ACE_STEP_DURATION_MAX = 600;

export type AceStepPayload = {
  input: {
    prompt: string;
    lyrics: string;
    duration: number;
    thinking: true;
    shift: number;
    audio_format: "mp3" | "wav";
  };
};

export function buildAceStepPayload(opts: {
  prompt: string;
  lyrics: string;
  durationSeconds: number;
  audioFormat?: "mp3" | "wav";
}): AceStepPayload {
  const duration = Math.min(
    ACE_STEP_DURATION_MAX,
    Math.max(ACE_STEP_DURATION_MIN, Math.round(opts.durationSeconds)),
  );
  const lyrics = (opts.lyrics.trim() || "[Instrumental]").slice(0, ACE_STEP_LYRICS_MAX);
  return {
    input: {
      prompt: opts.prompt.trim().slice(0, ACE_STEP_PROMPT_MAX),
      lyrics,
      duration,
      thinking: true,
      shift: 3.0,
      audio_format: opts.audioFormat === "wav" ? "wav" : "mp3",
    },
  };
}
