/**
 * Timed Hybrid Engine plan: 30s intro tag + concurrent core stems.
 *
 * 1. ElevenLabs — producer-tag intro, hard-capped at 30 seconds.
 * 2. MiniMax 2.6 — instrumental foundation for the full core length.
 * 3. Fish Audio ACE-Step 1.5 — vocal stems / arrangement for the same core length.
 *
 * MiniMax and ACE-Step are meant to run together; the intro is a separate 30s stem.
 */
import { buildAceStepPayload, type AceStepPayload } from "@/lib/ace-step-payload";
import { MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";
import { buildMiniMaxPayload, type MiniMaxPayload } from "@/lib/minimax-payload";

export const HYBRID_INTRO_SECONDS = 30;
export const HYBRID_DEFAULT_CORE_SECONDS = 180;
export const HYBRID_TIMING_SPEC = "30s intro + concurrent core stems";
export const HYBRID_ENGINES = ["Intro tag", "Instrumental core", "Vocal stems"] as const;

export type TimedHybridPlan = {
  introDuration: typeof HYBRID_INTRO_SECONDS;
  coreSeconds: number;
  timingSpec: typeof HYBRID_TIMING_SPEC;
  engines: typeof HYBRID_ENGINES;
  intro: { prompt: string; duration: typeof HYBRID_INTRO_SECONDS };
  minimax: MiniMaxPayload;
  acestep: AceStepPayload;
};

export function planTimedHybridTrack(input: {
  introPrompt: string;
  mainStylePrompt: string;
  lyricContent: string;
  totalDurationSec?: number;
  audioFormat?: "mp3" | "wav";
  bpm?: number;
  voiceId?: string;
  referenceAudioUrl?: string;
}): TimedHybridPlan {
  const coreSeconds = Math.min(
    MINIMAX_MAX_SECONDS,
    Math.max(10, Math.round(input.totalDurationSec ?? HYBRID_DEFAULT_CORE_SECONDS)),
  );
  const style = input.mainStylePrompt.trim();
  const introPrompt =
    input.introPrompt.trim() ||
    `${style}. 30-second producer tag intro, radio ident, no full verse.`;

  return {
    introDuration: HYBRID_INTRO_SECONDS,
    coreSeconds,
    timingSpec: HYBRID_TIMING_SPEC,
    engines: HYBRID_ENGINES,
    intro: { prompt: introPrompt, duration: HYBRID_INTRO_SECONDS },
    minimax: buildMiniMaxPayload({
      prompt: style,
      lyrics: "",
      instrumental: true,
      audioFormat: input.audioFormat,
      voiceId: input.voiceId,
    }),
    acestep: buildAceStepPayload({
      prompt: style,
      lyrics: input.lyricContent,
      durationSeconds: coreSeconds,
      audioFormat: input.audioFormat,
      bpm: input.bpm,
      voiceId: input.voiceId,
      referenceAudioUrl: input.referenceAudioUrl,
    }),
  };
}
