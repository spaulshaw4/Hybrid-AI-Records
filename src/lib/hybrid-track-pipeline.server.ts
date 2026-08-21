/**
 * Timed Hybrid Engine runner (server-only).
 *
 * 1. ElevenLabs Music — 30s producer-tag intro.
 * 2. MiniMax 2.6 — core instrumental foundation.
 * 3. Vocal stem — instant clone from the artist's take when one is saved,
 *    otherwise ACE-Step arrangement.
 */
import {
  requestAceStepGeneration,
  requestApiframeGeneration,
  requestElevenLabsMusic,
  waitForMusicPrediction,
  type ApiframeResult,
} from "@/lib/apiframe.server";
import { engineLog, newCorrelationId } from "@/lib/engine-log.server";
import { ELEVENLABS_MAX_SECONDS } from "@/lib/engine-routing";
import { planTimedHybridTrack } from "@/lib/hybrid-track-pipeline";

export type TimedHybridTrackResult = {
  status: "success";
  introStem: string | null;
  instrumentalStem: string | null;
  vocalStem: string | null;
  introDuration: 30;
  timingSpec: string;
  engines: readonly string[];
  taskIds: {
    intro: string | null;
    instrumental: string | null;
    vocals: string | null;
  };
};

function firstAudio(result: ApiframeResult): string | null {
  return result.tracks.find((track) => track.audioUrl)?.audioUrl ?? null;
}

async function settle(started: ApiframeResult, correlationId: string): Promise<ApiframeResult> {
  if (!started.taskId) throw new Error("Music engine: the provider returned no job id.");
  if (started.status === "succeeded") return started;
  return waitForMusicPrediction(started.taskId, correlationId);
}

export async function generateTimedHybridTrack(
  input: {
    introPrompt: string;
    mainStylePrompt: string;
    lyricContent: string;
    totalDurationSec?: number;
    audioFormat?: "mp3" | "wav";
    title?: string;
    language?: string;
    customLanguage?: string;
    userId?: string;
    referenceSampleUrl?: string;
  },
  correlationId: string = newCorrelationId("gen-hybrid"),
): Promise<TimedHybridTrackResult> {
  const plan = planTimedHybridTrack({
    introPrompt: input.introPrompt,
    mainStylePrompt: input.mainStylePrompt,
    lyricContent: input.lyricContent,
    totalDurationSec: input.totalDurationSec,
    audioFormat: input.audioFormat,
  });

  engineLog("info", "generate.hybrid.start", correlationId, {
    introDuration: plan.introDuration,
    coreSeconds: plan.coreSeconds,
    engines: plan.engines,
  });

  const introJob = requestElevenLabsMusic(
    {
      prompt: plan.intro.prompt,
      title: input.title ? `${input.title} intro` : "Intro tag",
      instrumental: false,
      audioFormat: input.audioFormat,
      musicLengthMs: ELEVENLABS_MAX_SECONDS * 1000,
    },
    `${correlationId}-intro`,
  );

  const instrumentalJob = requestApiframeGeneration(
    {
      prompt: input.mainStylePrompt,
      style: input.mainStylePrompt,
      title: input.title || "Instrumental",
      lyrics: "",
      instrumental: true,
      customMode: true,
      model: "V4_5",
      audioFormat: input.audioFormat,
      language: input.language,
      customLanguage: input.customLanguage,
    },
    `${correlationId}-minimax`,
  );

  const vocalJob =
    input.referenceSampleUrl && input.lyricContent.trim() && input.userId
      ? import("@/lib/fish-tts.server").then(({ cloneVocalsFromSample }) =>
          cloneVocalsFromSample({
            sampleUrl: input.referenceSampleUrl as string,
            lyrics: input.lyricContent,
            language: input.language,
            customLanguage: input.customLanguage,
            audioFormat: input.audioFormat,
            title: input.title || "Vocal stem",
            userId: input.userId as string,
            taskId: `${correlationId}-clone`,
          }),
        )
      : requestAceStepGeneration(
          {
            prompt: input.mainStylePrompt,
            lyrics: input.lyricContent,
            durationSeconds: plan.coreSeconds,
            audioFormat: input.audioFormat,
            title: input.title || "Vocal stem",
          },
          `${correlationId}-ace`,
        );

  const [introStarted, instrumentalStarted, vocalStarted] = await Promise.all([
    introJob,
    instrumentalJob,
    vocalJob,
  ]);

  const [intro, instrumental, vocals] = await Promise.all([
    settle(introStarted, `${correlationId}-intro`),
    settle(instrumentalStarted, `${correlationId}-minimax`),
    settle(vocalStarted, `${correlationId}-ace`),
  ]);

  const result: TimedHybridTrackResult = {
    status: "success",
    introStem: firstAudio(intro),
    instrumentalStem: firstAudio(instrumental),
    vocalStem: firstAudio(vocals),
    introDuration: 30,
    timingSpec: plan.timingSpec,
    engines: plan.engines,
    taskIds: {
      intro: intro.taskId,
      instrumental: instrumental.taskId,
      vocals: vocals.taskId,
    },
  };

  engineLog("info", "generate.hybrid.done", correlationId, {
    hasIntro: Boolean(result.introStem),
    hasInstrumental: Boolean(result.instrumentalStem),
    hasVocals: Boolean(result.vocalStem),
  });

  return result;
}
