/**
 * Server-only Hybrid Engine finish: stem split → vocal conversion → Matchering.
 *
 * Completed masters are uploaded only after Matchering (or its loudnorm
 * fallback) writes a premaster. Callers must not mark the job complete with
 * the raw Stage 1 mix.
 *
 * A vocal render halts on the first failure rather than degrading. Returning
 * the untouched engine mix would hand the artist a track that still carries
 * the original vocal, which is indistinguishable from success until they
 * listen. The caller charges the token only after this resolves, so throwing
 * leaves the artist unbilled.
 */
import {
  assertMasteringContractOutput,
  isHttpAudioUrl,
  logPostConditionPassed,
  logPreConditionPassed,
} from "@/lib/pipeline-contracts";
import { backingStemUrl } from "@/lib/stem-urls";
import { assertDemucsStemUrlGate } from "@/lib/studio-pipeline-gates";
import { logFailedStudioGate, shouldRethrowPipelineControlError } from "@/lib/studio-pipeline-error";

export type HybridMasterPipelineResult = {
  masterUrl: string | null;
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  mixed: boolean;
  matched: boolean;
};

async function downloadAudioBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Could not download audio (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("Downloaded audio was empty.");
  return bytes;
}

/**
 * Copy for a halted render. All stay vendor-neutral, and all promise the token
 * is safe: the caller charges only after this pipeline resolves, so throwing
 * here means the artist was never billed.
 */
const VOCAL_FAILURE_MESSAGE = "Vocal conversion failed. Your hybrid tokens have not been charged.";
const VOCAL_TIMEOUT_MESSAGE = "Vocal processing engine timed out. Please try your render again.";
const STEM_FAILURE_MESSAGE =
  "Stem separation failed. Your hybrid tokens have not been charged.";

function isTimeout(error: unknown): boolean {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /timed\s?out|timeout/i.test(message);
}

/**
 * Halts a render. The provider-specific cause goes to the server log; the artist
 * gets neutral copy naming the stage that actually failed — reporting a stem
 * failure as a vocal failure sends debugging to the wrong gate.
 */
function haltVocalRender(stage: "stem isolation" | "vocal conversion", error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[pipeline] ${stage} failed — halting render:`, detail);
  if (isTimeout(error)) return new Error(VOCAL_TIMEOUT_MESSAGE);
  return new Error(stage === "stem isolation" ? STEM_FAILURE_MESSAGE : VOCAL_FAILURE_MESSAGE);
}

/**
 * Archives a stem for the vault and returns a URL the rest of the pipeline can
 * still fetch. The dev local-vault fallback returns a relative path, which
 * `fetch` cannot resolve server-side, so keep the absolute upstream URL in that
 * case and let the archived copy exist only for the vault.
 */
async function archiveUrl(
  url: string | null,
  userId: string,
  taskId: string,
): Promise<string | null> {
  if (!url) return null;
  try {
    const { archiveGeneratedAudio } = await import("@/lib/apiframe.server");
    const archived = await archiveGeneratedAudio(url, userId, taskId);
    if (archived && !isHttpAudioUrl(archived)) {
      console.warn("[pipeline] archived stem is not fetchable remotely — keeping upstream URL", {
        archived,
        upstream: url,
      });
      return url;
    }
    return archived;
  } catch (error) {
    console.warn(
      "[pipeline] stem archive skipped",
      error instanceof Error ? error.message : error,
    );
    return url;
  }
}

/**
 * Stage 2–4 of generate: split the base mix, convert vocals on Fish Audio,
 * mix converted vocals with the Demucs backing, then Matchering-master.
 */
export async function runHybridMasterPipeline(input: {
  baseAudioUrl: string;
  lyrics: string;
  instrumental: boolean;
  referenceSampleUrl?: string;
  audioFormat?: "mp3" | "wav";
  title: string;
  userId: string;
  taskId: string;
}): Promise<HybridMasterPipelineResult> {
  let instrumentalUrl: string | null = input.instrumental ? input.baseAudioUrl : null;
  let isolatedVocalUrl: string | null = null;
  let convertedVocalUrl: string | null = null;

  const wantsVocals = !input.instrumental && input.lyrics.trim().length > 0;

  if (!isHttpAudioUrl(input.baseAudioUrl)) {
    logFailedStudioGate(new Error("FAIL_EARLY_GUARD: Stage 3: base audio URL was invalid"));
    throw haltVocalRender("stem isolation", new Error("base audio URL was invalid"));
  }
  logPreConditionPassed("stems", "base audio URL valid");
  const { PIPELINE_PROGRESS, reportPipelineProgress } = await import("@/lib/pipeline-progress");
  reportPipelineProgress("stems", PIPELINE_PROGRESS.stems);

  try {
    const baseBytes = await downloadAudioBytes(input.baseAudioUrl);
    const { separateStems } = await import("@/lib/stems.server");
    const stems = await separateStems({
      audio: baseBytes,
      filename: `${input.taskId}-base.mp3`,
    });
    if (wantsVocals) {
      assertDemucsStemUrlGate(stems, { required: true });
    }
    instrumentalUrl = (await archiveUrl(
      backingStemUrl(stems),
      input.userId,
      `${input.taskId}-instrumental`,
    )) ?? instrumentalUrl;
    isolatedVocalUrl = await archiveUrl(stems.vocals, input.userId, `${input.taskId}-demucs-vocals`);
  } catch (error) {
    // An instrumental render masters the base mix directly, so a failed split
    // costs nothing. A vocal render has no backing track to sing over without
    // it, and mastering the raw mix would hand back a track with the original
    // vocal still in it.
    const { logPipelineStepError } = await import("@/lib/pipeline-steps.server");
    logPipelineStepError("stems", error);
    logFailedStudioGate(error);
    if (shouldRethrowPipelineControlError(error)) throw error;
    if (wantsVocals) throw haltVocalRender("stem isolation", error);
    console.warn(
      "[pipeline] stem split skipped for instrumental render",
      error instanceof Error ? error.message : error,
    );
  }

  if (wantsVocals) {
    try {
      reportPipelineProgress("vocals", PIPELINE_PROGRESS.vocals);
      const { convertVocalsWithStems, cloneVocalsFromSample } = await import("@/lib/fish-tts.server");
      // These downloads used to swallow failures, which quietly demoted a
      // voice-converted render to plain text-to-speech, or dropped the
      // artist's own reference take without telling them.
      let isolatedVocal: Uint8Array | undefined;
      if (isolatedVocalUrl) {
        console.log("[GATE_4_DISPATCH] Sending vocal stem to Fish Audio:", isolatedVocalUrl);
        isolatedVocal = await downloadAudioBytes(isolatedVocalUrl);
      }
      const converted = input.referenceSampleUrl
        ? isolatedVocal
          ? await convertVocalsWithStems({
              lyrics: input.lyrics,
              isolatedVocal,
              referenceAudio: await downloadAudioBytes(input.referenceSampleUrl),
              audioFormat: input.audioFormat,
              title: `${input.title} vocals`,
              userId: input.userId,
              taskId: `${input.taskId}-fish-vocals`,
            })
          : await cloneVocalsFromSample({
              sampleUrl: input.referenceSampleUrl,
              lyrics: input.lyrics,
              audioFormat: input.audioFormat,
              title: `${input.title} vocals`,
              userId: input.userId,
              taskId: `${input.taskId}-fish-vocals`,
            })
        : await convertVocalsWithStems({
            lyrics: input.lyrics,
            isolatedVocal,
            audioFormat: input.audioFormat,
            title: `${input.title} vocals`,
            userId: input.userId,
            taskId: `${input.taskId}-fish-vocals`,
          });
      convertedVocalUrl = converted.tracks.find((track) => track.audioUrl)?.audioUrl ?? null;
    } catch (error) {
      const { logPipelineStepError } = await import("@/lib/pipeline-steps.server");
      logPipelineStepError("vocals", error);
      logFailedStudioGate(error);
      if (shouldRethrowPipelineControlError(error)) throw error;
      throw haltVocalRender("vocal conversion", error);
    }

    // A response with no usable audio is still a failed conversion. Falling
    // through here would master the untouched engine vocal and pass it off as
    // the converted one.
    if (!convertedVocalUrl) {
      throw haltVocalRender("vocal conversion", new Error("no converted vocal was returned"));
    }
  }

  const vocalUrl = convertedVocalUrl ?? isolatedVocalUrl;
  const mixVocalUrl = vocalUrl ?? (instrumentalUrl ? null : input.baseAudioUrl);
  const mixInstrumentalUrl = instrumentalUrl ?? (vocalUrl ? null : input.baseAudioUrl);

  reportPipelineProgress("master", PIPELINE_PROGRESS.master);
  const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
  const mastered = await mixAndMasterHybridTrack({
    introUrl: null,
    instrumentalUrl: mixInstrumentalUrl,
    vocalUrl: mixVocalUrl,
    userId: input.userId,
    taskId: input.taskId,
  });
  const master = assertMasteringContractOutput(mastered.masterUrl);
  logPostConditionPassed("Mastered audio ready");

  return {
    masterUrl: master.masteredAudioUrl,
    vocalUrl,
    instrumentalUrl,
    mixed: mastered.mixed,
    matched: mastered.matched,
  };
}
