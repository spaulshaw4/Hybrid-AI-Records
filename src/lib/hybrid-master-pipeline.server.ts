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
 * Gates 3–6: CWALO structure → Demucs → Fish vocals → FFmpeg remux/master.
 * Gate 2 (Supabase vault) must already have produced a public HTTPS URL.
 * Never re-run Demucs after Fish.
 */
export async function runHybridMasterPipeline(input: {
  baseAudioUrl: string;
  /**
   * Gate 2 public HTTPS CDN URL for Replicate (CWALO / Demucs). Must never
   * be a localhost / local-vault path.
   */
  publicBaseAudioUrl?: string;
  lyrics: string;
  instrumental: boolean;
  referenceSampleUrl?: string;
  audioFormat?: "mp3" | "wav";
  title: string;
  userId: string;
  taskId: string;
  /** Requested track length; the master is cut and faded to it. */
  durationSeconds?: number;
  /** Studio language selection, forwarded to the vocal stage. */
  language?: string;
  customLanguage?: string;
}): Promise<HybridMasterPipelineResult> {
  let instrumentalUrl: string | null = input.instrumental ? input.baseAudioUrl : null;
  let isolatedVocalUrl: string | null = null;
  let convertedVocalUrl: string | null = null;
  let remuxGains = { instrumentalVolume: 1.0, vocalVolume: 1.0 };
  let masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null = null;

  const wantsVocals = !input.instrumental && input.lyrics.trim().length > 0;

  const { isPublicHttpAudioUrl, preferPublicAudioUrl } = await import(
    "@/lib/pipeline-contracts"
  );
  const publicAudioUrl =
    preferPublicAudioUrl(input.publicBaseAudioUrl, input.baseAudioUrl) ?? null;
  if (!publicAudioUrl || !isPublicHttpAudioUrl(publicAudioUrl)) {
    logFailedStudioGate(
      new Error("FAIL_EARLY_GUARD: Gate 3: public HTTPS vault URL required (refused localhost)"),
    );
    throw haltVocalRender(
      "stem isolation",
      new Error("Gate 2 public HTTPS URL was missing before CWALO"),
    );
  }
  if (!isHttpAudioUrl(input.baseAudioUrl) && !isHttpAudioUrl(publicAudioUrl)) {
    logFailedStudioGate(new Error("FAIL_EARLY_GUARD: Gate 3: base audio URL was invalid"));
    throw haltVocalRender("stem isolation", new Error("base audio URL was invalid"));
  }
  logPreConditionPassed("stems", "public HTTPS vault URL valid");
  const { PIPELINE_PROGRESS, reportPipelineProgress } = await import("@/lib/pipeline-progress");
  const pipelineAudioUrl = publicAudioUrl;

  // Gate 3 — CWALO structure analysis on the Gate 2 public CDN URL.
  try {
    reportPipelineProgress("cwalo", PIPELINE_PROGRESS.cwalo);
    const { logPipelineStep } = await import("@/lib/pipeline-steps.server");
    logPipelineStep("cwalo");
    const { analyzeMusicStructureWithCwalo } = await import("@/lib/cwalo-structure.server");
    const { logGateStarting, logGateFinished, withGateTimeout } = await import(
      "@/lib/pipeline-gate.server"
    );
    logGateStarting(3, pipelineAudioUrl.slice(0, 72));
    const structure = await withGateTimeout(3, analyzeMusicStructureWithCwalo(pipelineAudioUrl));
    logGateFinished(
      3,
      `sections=${structure.sections.length} trackEnd=${structure.trackEnd ?? "n/a"}`,
    );
    remuxGains = structure.remux;
    masterPlan = structure.masterPlan;
    console.warn("[GATE_3_CWALO] guiding Demucs remux + Gate 6 master", {
      bpm: structure.bpm,
      sectionCount: structure.sections.length,
      energyPoints: structure.energyProfile.length,
      outroStart: structure.outroStart,
      trackEnd: structure.trackEnd,
      remuxGains,
      dynamicRemux: Boolean(masterPlan.instrumentalVolumeExpr),
    });
  } catch (error) {
    const { logPipelineStepError } = await import("@/lib/pipeline-steps.server");
    logPipelineStepError("cwalo", error);
    logFailedStudioGate(error);
    // Soft-fail: Demucs + Fish remux still proceed with default gains so a
    // CWALO outage cannot strand an otherwise healthy Gate 1–2 render.
    console.warn(
      "[GATE_3_CWALO] continuing with default remux gains",
      error instanceof Error ? error.message : error,
    );
  }

  reportPipelineProgress("stems", PIPELINE_PROGRESS.stems);

  try {
    const { logGateStarting, logGateFinished, withGateTimeout } = await import(
      "@/lib/pipeline-gate.server"
    );
    logGateStarting(4);
    const { separateStems } = await import("@/lib/stems.server");
    const stems = await withGateTimeout(
      4,
      (async () => {
        const baseBytes = await downloadAudioBytes(pipelineAudioUrl);
        return separateStems({
          audio: baseBytes,
          filename: `${input.taskId}-base.mp3`,
        });
      })(),
    );
    logGateFinished(4, `vocals=${Boolean(stems.vocals)} backing=${Boolean(backingStemUrl(stems))}`);
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
      const { logGateStarting, logGateFinished, withGateTimeout } = await import(
        "@/lib/pipeline-gate.server"
      );
      logGateStarting(5);
      const { convertVocalsWithStems, cloneVocalsFromSample } = await import("@/lib/fish-tts.server");
      const converted = await withGateTimeout(
        5,
        (async () => {
          let isolatedVocal: Uint8Array | undefined;
          if (isolatedVocalUrl) {
            console.log("[GATE_5_DISPATCH] Sending vocal stem to Fish Audio:", isolatedVocalUrl);
            isolatedVocal = await downloadAudioBytes(isolatedVocalUrl);
          }
          if (input.referenceSampleUrl) {
            if (isolatedVocal) {
              return convertVocalsWithStems({
                lyrics: input.lyrics,
                isolatedVocal,
                referenceAudio: await downloadAudioBytes(input.referenceSampleUrl),
                audioFormat: input.audioFormat,
                title: `${input.title} vocals`,
                userId: input.userId,
                taskId: `${input.taskId}-fish-vocals`,
                language: input.language,
                customLanguage: input.customLanguage,
              });
            }
            return cloneVocalsFromSample({
              sampleUrl: input.referenceSampleUrl,
              lyrics: input.lyrics,
              audioFormat: input.audioFormat,
              title: `${input.title} vocals`,
              userId: input.userId,
              taskId: `${input.taskId}-fish-vocals`,
              language: input.language,
              customLanguage: input.customLanguage,
            });
          }
          return convertVocalsWithStems({
            lyrics: input.lyrics,
            isolatedVocal,
            audioFormat: input.audioFormat,
            title: `${input.title} vocals`,
            userId: input.userId,
            taskId: `${input.taskId}-fish-vocals`,
            language: input.language,
            customLanguage: input.customLanguage,
          });
        })(),
      );
      convertedVocalUrl = converted.tracks.find((track) => track.audioUrl)?.audioUrl ?? null;
      logGateFinished(5, convertedVocalUrl ? "vocal url ready" : "no vocal url");
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

  // Fish (or Demucs vocal fallback) over the Gate 4 Demucs instrumental only.
  // Do not fall back to the full Gate 1 mix when stems exist — that reintroduces
  // the stock vocal and hollows the arrangement.
  const vocalUrl = convertedVocalUrl ?? isolatedVocalUrl;
  const mixVocalUrl = vocalUrl ?? (instrumentalUrl ? null : pipelineAudioUrl);
  const mixInstrumentalUrl =
    instrumentalUrl ?? (wantsVocals ? null : pipelineAudioUrl);

  if (wantsVocals && (!mixVocalUrl || !mixInstrumentalUrl)) {
    throw haltVocalRender(
      "vocal conversion",
      new Error("missing Fish vocal or Gate 4 instrumental for remux"),
    );
  }

  console.warn("[GATE_6_REMUX]", {
    instrumental: mixInstrumentalUrl ? "gate4-demucs" : "none",
    vocal: convertedVocalUrl ? "fish" : isolatedVocalUrl ? "demucs-vocal" : "none",
    amix: "duration=first:dropout_transition=2",
    remuxGains,
    cwalo: masterPlan
      ? {
          sections: masterPlan.sections.length,
          outroStart: masterPlan.outroStart,
          trackEnd: masterPlan.trackEnd,
          fadeOutSeconds: masterPlan.fadeOutSeconds,
          dynamicRemux: Boolean(masterPlan.instrumentalVolumeExpr),
        }
      : null,
  });

  reportPipelineProgress("master", PIPELINE_PROGRESS.master);
  const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
  const { logGateStarting, logGateFinished, withGateTimeout } = await import(
    "@/lib/pipeline-gate.server"
  );
  logGateStarting(6);
  const mastered = await withGateTimeout(
    6,
    mixAndMasterHybridTrack({
      introUrl: null,
      instrumentalUrl: mixInstrumentalUrl,
      vocalUrl: mixVocalUrl,
      userId: input.userId,
      taskId: input.taskId,
      maxSeconds: input.durationSeconds,
      remuxGains: {
        ...remuxGains,
        instrumentalVolumeExpr: masterPlan?.instrumentalVolumeExpr,
        vocalVolumeExpr: masterPlan?.vocalVolumeExpr,
      },
      cwaloGuide: masterPlan
        ? {
            trackEnd: masterPlan.trackEnd ?? undefined,
            outroStart: masterPlan.outroStart ?? undefined,
            fadeOutSeconds: masterPlan.fadeOutSeconds,
            sectionCount: masterPlan.sections.length,
          }
        : undefined,
    }),
  );
  logGateFinished(6, mastered.masterUrl ? "master url ready" : "no master");
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
