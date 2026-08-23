/**
 * Explicit 6-gate studio orchestrator with circuit breakers, flight-pattern
 * fallbacks, filing locks, and PipelineResponse landing contracts.
 */

import {
  GATE_TIMEOUTS_MS,
  withTimeout,
} from "@/lib/pipeline-gate.server";
import { isPublicHttpAudioUrl } from "@/lib/pipeline-contracts";
import { PIPELINE_PROGRESS, reportPipelineProgress } from "@/lib/pipeline-progress";
import { logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";
import { backingStemUrl } from "@/lib/stem-urls";
import { assertDemucsStemUrlGate } from "@/lib/studio-pipeline-gates";
import { logFailedStudioGate, shouldRethrowPipelineControlError } from "@/lib/studio-pipeline-error";
import { ResidueCleanup } from "@/lib/six-gate-landing.server";
import {
  acquireTrackLock,
  releaseTrackLock,
  TrackLockConflictError,
} from "@/lib/track-lock.server";
import {
  FALLBACK_CWALO_DEFAULT_STRUCTURE,
  FALLBACK_FISH_AUDIO_RAW_VOCALS,
  FALLBACK_STATIC_MASTER_FFMPEG,
  bumpTelemetry,
  createGateTelemetry,
  recordFallback,
  type Gate2Result,
  type Gate3Result,
  type Gate4Result,
  type GateTelemetry,
  type LandingAbortResponse,
  type LandingSuccessResponse,
  type MusicSectionMarker,
  type PipelineResponse,
} from "@/types/pipeline";

export type SixGatePipelineResult = {
  masterUrl: string;
  publicAudioUrl: string;
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  mixed: boolean;
  matched: boolean;
  rawAudioUrl: string;
  landing: LandingSuccessResponse;
  telemetry: GateTelemetry;
};

const STEM_FAILURE = "Stem separation failed. Your hybrid tokens have not been charged.";

function haltStem(error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[Circuit Breaker] stem isolation failed — exiting cleanly:`, detail);
  return new Error(STEM_FAILURE);
}

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

function markersToMasterPlan(
  gate3: Gate3Result,
  buildCwaloMasterPlan: typeof import("@/lib/cwalo-structure.server").buildCwaloMasterPlan,
): import("@/lib/cwalo-structure.server").CwaloMasterPlan {
  const sections = gate3.markers.map((m) => ({
    start: m.start,
    end: m.end,
    label: m.label,
  }));
  return buildCwaloMasterPlan({
    sections,
    bpm: gate3.bpm ?? null,
    beats: [],
    downbeats: [],
    energyProfile: gate3.markers.map((m) => m.energyLevel ?? 0.7),
    durationSeconds: gate3.markers.at(-1)?.end ?? null,
    outroStart: gate3.markers.find((m) => m.label === "outro")?.start ?? null,
    trackEnd: gate3.markers.at(-1)?.end ?? null,
  });
}

function structuralMarkersFromPlan(
  plan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null,
  fallback: MusicSectionMarker[],
): MusicSectionMarker[] {
  if (!plan?.sections?.length) return fallback;
  const allowed = new Set(["intro", "verse", "chorus", "bridge", "solo", "outro"]);
  return plan.sections
    .map((s) => {
      const label = s.label.trim().toLowerCase().split(/\s+/)[0] ?? "verse";
      const normalized = (allowed.has(label) ? label : "verse") as MusicSectionMarker["label"];
      return {
        label: normalized,
        start: s.start,
        end: s.end,
        energyLevel: undefined,
      };
    });
}

/**
 * Run gates 2–6 after Gate 1 has a fetchable audio URL.
 * Acquires a process lock for `taskId`; always releases in `finally`.
 */
export async function runSixGatePipeline(input: {
  gate1AudioUrl: string;
  lyrics: string;
  instrumental: boolean;
  referenceSampleUrl?: string;
  audioFormat?: "mp3" | "wav";
  title: string;
  userId: string;
  taskId: string;
  durationSeconds?: number;
  language?: string;
  customLanguage?: string;
}): Promise<SixGatePipelineResult> {
  if (!acquireTrackLock(input.taskId)) {
    throw new TrackLockConflictError(input.taskId);
  }

  const residue = new ResidueCleanup();
  const startedAt = Date.now();
  let telemetry = createGateTelemetry({ stage: "gate_1_generating", currentGate: 1 });
  const wantsVocals = !input.instrumental && input.lyrics.trim().length > 0;
  let remuxGains = { instrumentalVolume: 1.0, vocalVolume: 1.0 };
  let masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null = null;
  let structuralMarkers: MusicSectionMarker[] = [];
  let useFallbackStructure = false;

  try {
    // ── Pre-flight Gate 1 URL ─────────────────────────────────────────────
    if (!/^https?:\/\//i.test(input.gate1AudioUrl)) {
      throw new Error("[Circuit Breaker] Gate 1 failed: incoming audio URL was invalid.");
    }

    console.log("[Gate 1/6] Base Generation buffer ingest...");
    telemetry = bumpTelemetry(telemetry, 1, "gate_1_generating");
    const rawAudioBuffer = await withTimeout(
      downloadAudioBytes(input.gate1AudioUrl),
      GATE_TIMEOUTS_MS[1],
      "Gate 1 (AIMusicAPI buffer)",
    );
    if (!rawAudioBuffer.byteLength) {
      throw new Error("[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.");
    }
    residue.trackBuffer(rawAudioBuffer);

    // ── Gate 2 ────────────────────────────────────────────────────────────
    telemetry = bumpTelemetry(telemetry, 2, "gate_2_vaulting");
    reportPipelineProgress("vault", PIPELINE_PROGRESS.vault);
    logPipelineStep("vault");
    const { runGate2SupabaseVault } = await import("@/lib/gate2-vault.server");
    const vaulted = await runGate2SupabaseVault({
      rawAudioBuffer,
      trackId: input.taskId,
    });
    const gate2: Gate2Result = {
      trackId: input.taskId,
      publicCdnUrl: vaulted.publicAudioUrl,
      storagePath: vaulted.rawPath,
    };
    if (!isPublicHttpAudioUrl(gate2.publicCdnUrl)) {
      throw new Error(
        "[Circuit Breaker] Gate 2 failed: Invalid public HTTPS CDN URL generated.",
      );
    }
    const publicAudioUrl = gate2.publicCdnUrl;
    console.log(`[Gate 2/6] Pre-flight CDN OK — routing to Gates 3/4`);

    // ── Gate 3 (CWALO, soft-fail → default structure) ─────────────────────
    telemetry = bumpTelemetry(telemetry, 3, "gate_3_analyzing");
    reportPipelineProgress("cwalo", PIPELINE_PROGRESS.cwalo);
    logPipelineStep("cwalo");
    console.log("[Gate 3/6] CWALO Analysis...");
    let gate3: Gate3Result;
    try {
      if (!isPublicHttpAudioUrl(publicAudioUrl)) {
        throw new Error("Gate 3 pre-flight: public CDN URL required.");
      }
      const { analyzeMusicStructureWithCwalo } = await import("@/lib/cwalo-structure.server");
      const structure = await withTimeout(
        analyzeMusicStructureWithCwalo(publicAudioUrl),
        GATE_TIMEOUTS_MS[3],
        "Gate 3 (CWALO Replicate)",
      );
      remuxGains = structure.remux;
      masterPlan = structure.masterPlan;
      structuralMarkers = structuralMarkersFromPlan(structure.masterPlan, []);
      gate3 = {
        trackId: input.taskId,
        isFallback: false,
        markers: structuralMarkers,
        bpm: structure.bpm ?? undefined,
      };
      console.log(
        `[Gate 3/6] Finished — sections=${structure.sections.length} trackEnd=${structure.trackEnd ?? "n/a"}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[Circuit Breaker Tripped] Gate 3 CWALO bypassed — useFallbackStructure=true:",
        message,
      );
      logPipelineStepError("cwalo", err);
      logFailedStudioGate(err);
      useFallbackStructure = true;
      telemetry = recordFallback(telemetry, FALLBACK_CWALO_DEFAULT_STRUCTURE);
      const { generateDefaultStructure } = await import("@/lib/pipeline-fallbacks.server");
      const { buildCwaloMasterPlan } = await import("@/lib/cwalo-structure.server");
      gate3 = generateDefaultStructure(input.durationSeconds ?? 180, input.taskId);
      structuralMarkers = gate3.markers;
      masterPlan = markersToMasterPlan(gate3, buildCwaloMasterPlan);
      remuxGains = masterPlan.remux;
    }

    // ── Gate 4 ────────────────────────────────────────────────────────────
    telemetry = bumpTelemetry(telemetry, 4, "gate_4_splitting");
    reportPipelineProgress("stems", PIPELINE_PROGRESS.stems);
    console.log("[Gate 4/6] Demucs Stems...");
    if (!isPublicHttpAudioUrl(publicAudioUrl)) {
      throw new Error("Gate 4 pre-flight: public CDN URL required.");
    }

    let instrumentalUrl: string | null = input.instrumental ? publicAudioUrl : null;
    let isolatedVocalUrl: string | null = null;
    let gate4: Gate4Result | null = null;

    try {
      const { separateStemsFromPublicUrl } = await import("@/lib/stems.server");
      const stems = await withTimeout(
        separateStemsFromPublicUrl(publicAudioUrl),
        GATE_TIMEOUTS_MS[4],
        "Gate 4 (Demucs Separation)",
      );
      const vocals = stems.vocals;
      const noVocals = backingStemUrl(stems);
      if (wantsVocals && (!vocals || !noVocals)) {
        throw new Error(
          "[Circuit Breaker] Gate 4 failed: Missing split stems in Demucs payload.",
        );
      }
      if (wantsVocals) assertDemucsStemUrlGate(stems, { required: true });
      instrumentalUrl = noVocals ?? instrumentalUrl;
      isolatedVocalUrl = vocals;
      if (vocals && noVocals) {
        gate4 = {
          trackId: input.taskId,
          vocalStemUrl: vocals,
          backingStemUrl: noVocals,
        };
      }
      console.log(
        `[Gate 4/6] Finished — vocals=${Boolean(vocals)} no_vocals=${Boolean(noVocals)}`,
      );
    } catch (error) {
      logPipelineStepError("stems", error);
      logFailedStudioGate(error);
      if (shouldRethrowPipelineControlError(error)) throw error;
      if (wantsVocals) throw haltStem(error);
      console.warn(
        "[Circuit Breaker] Gate 4 skipped for instrumental render",
        error instanceof Error ? error.message : error,
      );
    }

    // ── Gate 5 (Fish → Demucs vocal fallback) ─────────────────────────────
    let mixVocalUrl: string | null = null;
    let fishFallback = false;
    if (wantsVocals) {
      telemetry = bumpTelemetry(telemetry, 5, "gate_5_converting");
      reportPipelineProgress("vocals", PIPELINE_PROGRESS.vocals);
      console.log("[Gate 5/6] Fish Audio Voice Conversion...");
      if (!isolatedVocalUrl) {
        throw haltStem(new Error("Gate 5 pre-flight: Demucs vocal stem URL missing."));
      }
      try {
        const { convertVocalsWithStems } = await import("@/lib/fish-tts.server");
        const converted = await withTimeout(
          (async () => {
            const isolatedVocal = await downloadAudioBytes(isolatedVocalUrl!);
            residue.trackBuffer(isolatedVocal);
            if (!isolatedVocal.byteLength) {
              throw new Error("[Circuit Breaker] Gate 5 failed: Empty vocal conversion buffer.");
            }
            if (input.referenceSampleUrl) {
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
          GATE_TIMEOUTS_MS[5],
          "Gate 5 (Fish Audio)",
        );
        mixVocalUrl = converted.tracks.find((t) => t.audioUrl)?.audioUrl ?? null;
        if (!mixVocalUrl) {
          throw new Error("[Circuit Breaker] Gate 5 failed: Empty vocal conversion buffer.");
        }
        console.log("[Gate 5/6] Finished — vocal url ready");
      } catch (error) {
        logPipelineStepError("vocals", error);
        logFailedStudioGate(error);
        if (shouldRethrowPipelineControlError(error)) throw error;
        console.warn(
          "[Fallback Triggered] Fish Audio failed — routing Demucs vocal to Gate 6",
          error instanceof Error ? error.message : error,
        );
        const { fetchRawVocalFallback } = await import("@/lib/pipeline-fallbacks.server");
        const raw = await fetchRawVocalFallback(isolatedVocalUrl, input.taskId);
        residue.trackBuffer(raw.convertedVocalBuffer);
        mixVocalUrl = isolatedVocalUrl;
        fishFallback = true;
        telemetry = recordFallback(telemetry, FALLBACK_FISH_AUDIO_RAW_VOCALS);
        console.log("[Gate 5/6] Detour complete — Demucs vocal → Gate 6");
      }
    }

    const vocalUrl = mixVocalUrl ?? isolatedVocalUrl;
    const mixInstrumentalUrl =
      instrumentalUrl ?? (wantsVocals ? null : publicAudioUrl);

    if (wantsVocals && (!mixVocalUrl || !mixInstrumentalUrl)) {
      throw haltStem(new Error("missing vocal or Gate 4 instrumental for remux"));
    }

    // ── Gate 6 ────────────────────────────────────────────────────────────
    telemetry = bumpTelemetry(telemetry, 6, "gate_6_mastering");
    reportPipelineProgress("master", PIPELINE_PROGRESS.master);
    console.log(
      `[Gate 6/6] FFmpeg Dynamic Master (${useFallbackStructure ? "fallback" : "CWALO"} markers)...`,
    );
    const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
    let mastered = await withTimeout(
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
      GATE_TIMEOUTS_MS[6],
      "Gate 6 (FFmpeg Remux + Vault)",
    );

    if (!mastered.masterUrl || !mastered.mixed) {
      // Inner static filter may still have run; treat hard miss as fatal.
      throw new Error(
        "[Circuit Breaker] Gate 6 failed: Mastering did not produce a playable master.",
      );
    }
    if (telemetry.fallbacksApplied.includes(FALLBACK_STATIC_MASTER_FFMPEG) === false) {
      // Static fallback is recorded inside matchering when triggered; leave telemetry as-is.
    }

    let finalMasterUrl = mastered.masterUrl;
    if (!isPublicHttpAudioUrl(finalMasterUrl) && !finalMasterUrl.startsWith("http")) {
      throw new Error(
        "[Circuit Breaker] Gate 6 failed: Invalid master URL after vault commit.",
      );
    }
    if (!isPublicHttpAudioUrl(finalMasterUrl)) {
      const { uploadMasterToVaultFromUrl } = await import("@/lib/audio-vault-upload.server");
      finalMasterUrl = await withTimeout(
        uploadMasterToVaultFromUrl(mastered.masterUrl, input.taskId, "mp3"),
        GATE_TIMEOUTS_MS[6],
        "Gate 6 (Supabase Final Commit)",
      );
    }

    const executionTimeMs = Date.now() - startedAt;
    const fallbacksUsed = telemetry.fallbacksApplied;
    const landingStatus = fallbacksUsed.length > 0 ? "completed_fallback" : "success";
    telemetry = bumpTelemetry(
      telemetry,
      6,
      landingStatus === "success" ? "landing_success" : "landing_fallback",
    );

    const landing: LandingSuccessResponse = {
      status: landingStatus,
      trackId: input.taskId,
      masterUrl: finalMasterUrl,
      duration: input.durationSeconds ?? structuralMarkers.at(-1)?.end ?? 0,
      structuralMarkers,
      fallbacksUsed,
      executionTimeMs,
    };

    console.log(`[Pipeline Complete] Master ready: ${finalMasterUrl.slice(0, 96)}`);
    void gate3;
    void gate4;
    void fishFallback;

    return {
      masterUrl: finalMasterUrl,
      publicAudioUrl,
      vocalUrl,
      instrumentalUrl,
      mixed: mastered.mixed,
      matched: mastered.matched,
      rawAudioUrl: publicAudioUrl,
      landing,
      telemetry,
    };
  } finally {
    await residue.dispose().catch(() => undefined);
    releaseTrackLock(input.taskId);
  }
}

/** Build a typed abort landing for controllers. */
export function buildAbortPipelineResponse(
  trackId: string,
  error: unknown,
  startedAt: number,
): LandingAbortResponse {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  let failedGate = 6;
  const gateMatch = message.match(/Gate\s*([1-6])(?:\/6)?/i);
  if (gateMatch) failedGate = Number(gateMatch[1]);
  else if (/AIMusicAPI|empty audio buffer/i.test(message)) failedGate = 1;
  else if (/Supabase|vault|public HTTPS CDN/i.test(message)) failedGate = 2;
  else if (/Demucs|stem/i.test(message)) failedGate = 4;
  return {
    status: "failed",
    trackId,
    failedGate: `Gate ${failedGate}`,
    error: message,
    executionTimeMs: Date.now() - startedAt,
  };
}

export type { PipelineResponse };
