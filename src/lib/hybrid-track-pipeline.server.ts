/**
 * Timed Hybrid Engine runner (server-only).
 *
 * 1. ElevenLabs Music — 30s producer-tag intro.
 * 2. MiniMax 2.6 — core instrumental foundation.
 * 3. Fish Audio native TTS (`https://api.fish.audio/v1/tts`) — vocal stem.
 *    Never falls back to Replicate ACE-Step.
 */
import {
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
    voiceId?: string;
    referenceSampleUrl?: string;
    bpm?: number;
    preserveUserPrompt?: boolean;
  },
  correlationId: string = newCorrelationId("gen-hybrid"),
): Promise<TimedHybridTrackResult> {
  const plan = planTimedHybridTrack({
    introPrompt: input.introPrompt,
    mainStylePrompt: input.mainStylePrompt,
    lyricContent: input.lyricContent,
    totalDurationSec: input.totalDurationSec,
    audioFormat: input.audioFormat,
    bpm: input.bpm,
    voiceId: input.voiceId,
    referenceAudioUrl: input.referenceSampleUrl,
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
      voiceId: input.voiceId,
      referenceAudioUrl: input.referenceSampleUrl,
      preserveUserPrompt: input.preserveUserPrompt !== false,
    },
    `${correlationId}-minimax`,
  );

  const customVoice = Boolean(input.referenceSampleUrl && input.lyricContent.trim() && input.userId);
  const vocalJob = !input.lyricContent.trim()
    ? Promise.resolve({
        taskId: `${correlationId}-fish-vocals`,
        status: "succeeded" as const,
        tracks: [],
        raw: { skipped: true },
      } satisfies ApiframeResult)
    : import("@/lib/fish-tts.server").then(({ cloneVocalsFromSample, convertVocalsWithStems }) => {
        if (!input.userId) {
          console.error("[FISH_AUDIO] vocal conversion aborted — signed-in user required");
          throw new Error("Fish Audio vocals need a signed-in user.");
        }
        if (customVoice) {
          return cloneVocalsFromSample({
            sampleUrl: input.referenceSampleUrl as string,
            lyrics: input.lyricContent,
            language: input.language,
            customLanguage: input.customLanguage,
            audioFormat: input.audioFormat,
            title: input.title || "Vocal stem",
            userId: input.userId,
            taskId: `${correlationId}-clone`,
            voiceId: input.voiceId,
          });
        }
        return convertVocalsWithStems({
          lyrics: input.lyricContent,
          audioFormat: input.audioFormat,
          title: input.title || "Vocal stem",
          userId: input.userId,
          taskId: `${correlationId}-fish-vocals`,
        });
      });

  const [introStarted, instrumentalStarted, vocalStarted] = await Promise.all([
    introJob,
    instrumentalJob,
    vocalJob,
  ]);

  const [intro, instrumental, vocals] = await Promise.all([
    settle(introStarted, `${correlationId}-intro`),
    settle(instrumentalStarted, `${correlationId}-minimax`),
    settle(vocalStarted, `${correlationId}-fish`),
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
