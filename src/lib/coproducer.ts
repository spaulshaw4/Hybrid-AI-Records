import {
  assertPipelineBreakerClosed,
  recordPipelineFailure,
  recordPipelineSuccess,
} from "@/lib/pipeline-breaker";
import {
  assertLyricsContractInput,
  assertLyricsContractOutput,
  isFailEarlyGuardError,
  isPipelineBreakerOpenError,
  logGateCleared,
  logPostConditionPassed,
  logPreConditionPassed,
} from "@/lib/pipeline-contracts";
import { lyricPipelineKey, logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";
import { REPLICATE_GEMINI_FLASH, replicateGeminiFlashLyrics } from "@/lib/replicate-llm.server";
import { logFailedStudioGate } from "@/lib/studio-pipeline-error";

/** Gemini 2.5 Flash on Replicate. Override with COPRODUCER_REPLICATE_MODEL. */
export const COPRODUCER_REPLICATE_MODEL =
  (typeof process !== "undefined" && process.env["COPRODUCER_REPLICATE_MODEL"]?.trim()) ||
  REPLICATE_GEMINI_FLASH;

/** Hard cap so a hung lyric call cannot leave the studio on a spinner. */
export const LYRIC_ENGINE_TIMEOUT_MS = 30_000;
export const LYRIC_ENGINE_TIMEOUT_MESSAGE = "Lyric engine timed out";

const LYRIC_SYSTEM_PROMPT =
  "You are an elite music co-producer. Write complete song lyrics with section markers " +
  "([Verse], [Chorus], [Bridge], [Outro]). Return only the lyrics — no commentary, " +
  "no markdown fences, no title line unless it is part of the lyrics.";

export function isLyricEngineTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === "AbortError" ||
    error.message === LYRIC_ENGINE_TIMEOUT_MESSAGE ||
    /timed out|aborted/i.test(error.message)
  );
}

function lyricTimeoutError() {
  return new Error(LYRIC_ENGINE_TIMEOUT_MESSAGE);
}

function lyricEngineKey(): string | undefined {
  return lyricPipelineKey();
}

function publicLyricError(error: unknown): Error {
  if (isLyricEngineTimeout(error)) return lyricTimeoutError();
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/not configured/i.test(raw)) {
    return new Error("The Co-Producer is not configured. Add the lyric engine API key to .env.local.");
  }
  if (/insufficient|402|credit/i.test(raw)) {
    return new Error(
      "The Co-Producer lyric-engine Replicate account needs credit (LYRIC_ENGINE_API_KEY). Top up that account and retry.",
    );
  }
  console.error("[LYRIC_ENGINE_ERROR]", error);
  return new Error("The Co-Producer could not write lyrics. Please try again.");
}

async function withLyricEngineTimeout<T>(work: Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LYRIC_ENGINE_TIMEOUT_MS);
  const pending = work.catch((error) => {
    if (controller.signal.aborted) return Promise.reject(lyricTimeoutError());
    return Promise.reject(error);
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        const fail = () => reject(lyricTimeoutError());
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function writeLyricsWithStudio(trackTitle: string, language: string) {
  if (!lyricEngineKey()) {
    throw new Error("The Co-Producer is not configured. Add the lyric engine API key to .env.local.");
  }

  assertPipelineBreakerClosed("lyrics");
  const title = trackTitle || "Untitled Track";
  const lang = language || "English";
  const prompt = assertLyricsContractInput({
    prompt:
      `Write complete song lyrics in ${lang} with section markers ` +
      `([Verse], [Chorus], [Bridge], [Outro]) for a track titled "${title}". ` +
      `Return only the lyrics.`,
  });
  logPreConditionPassed("lyrics", "prompt valid");

  try {
    logPipelineStep("lyrics");
    const lyrics = await withLyricEngineTimeout(
      replicateGeminiFlashLyrics({
        prompt,
        systemInstruction: LYRIC_SYSTEM_PROMPT,
        timeoutMs: LYRIC_ENGINE_TIMEOUT_MS,
      }),
    );
    const output = assertLyricsContractOutput(lyrics);
    recordPipelineSuccess("lyrics");
    logGateCleared(1, `Lyrics verified (${output.lyrics.length} chars)`);
    logPostConditionPassed("Cleaned lyrics ready for Base Audio");
    return output;
  } catch (error: unknown) {
    recordPipelineFailure("lyrics", error);
    logFailedStudioGate(error);
    if (isFailEarlyGuardError(error) || isPipelineBreakerOpenError(error)) {
      throw error;
    }
    logPipelineStepError("lyrics", error);
    throw publicLyricError(error);
  }
}

/** Alias used by engine callers and the Co-Producer HTTP route. */
export async function writeLyricsDirect(trackTitle: string, language: string) {
  return writeLyricsWithStudio(trackTitle, language);
}
