/**
 * Canonical 6-gate execution pipeline — mirrors the flight-plan sketch:
 * lock → Gate 1–6 with circuit breakers → unlock + temp cleanup in finally.
 */

import { AUDIO_VAULT_BUCKET } from "@/lib/audio-vault";
import { createEngineSupabaseClient } from "@/lib/engine-pipeline.server";
import { GATE_TIMEOUTS_MS, withTimeout } from "@/lib/pipeline-gate.server";
import { isPublicHttpAudioUrl } from "@/lib/pipeline-contracts";
import {
  generateDefaultStructure,
  fetchRawVocalFallback,
} from "@/lib/pipeline-fallbacks.server";
import { ResidueCleanup } from "@/lib/six-gate-landing.server";
import { backingStemUrl } from "@/lib/stem-urls";
import {
  acquireTrackLock,
  releaseTrackLock,
  TrackLockConflictError,
  cleanupAudioWriteResidue,
} from "@/lib/track-lock.server";
import {
  FALLBACK_CWALO_DEFAULT_STRUCTURE,
  FALLBACK_FISH_AUDIO_RAW_VOCALS,
  createGateTelemetry,
  type Gate3Result,
  type LandingAbortResponse,
  type LandingSuccessResponse,
  type MusicSectionMarker,
  type PipelineResponse,
} from "@/types/pipeline";
import {
  afterGate,
  beforeGate,
  runSafeHook,
  safeBumpTelemetry,
  safeRecordFallback,
  safeUpdateTrackStatus,
} from "@/lib/pipeline-hooks.server";

export type ExecutePipelineInput = {
  trackId: string;
  prompt: string;
  style: string;
  userId: string;
  /** When set, Gate 1 waits on this AIMusicAPI task instead of creating a new one. */
  gate1TaskId?: string;
  /** Pre-fetched Gate 1 CDN URL (skips create+poll when provided with buffer). */
  gate1AudioUrl?: string;
  lyrics?: string;
  instrumental?: boolean;
  referenceSampleUrl?: string;
  audioFormat?: "mp3" | "wav";
  title?: string;
  durationSeconds?: number;
  language?: string;
  customLanguage?: string;
};

export type ExecutePipelineSuccess = LandingSuccessResponse & {
  vocalUrl: string | null;
  instrumentalUrl: string | null;
  publicAudioUrl: string;
  mixed: boolean;
  matched: boolean;
};

/** Thrown after outer catch builds a typed abort landing for the client. */
export class PipelineAbortError extends Error {
  readonly landing: LandingAbortResponse;
  readonly statusCode = 500 as const;

  constructor(landing: LandingAbortResponse) {
    super(landing.error);
    this.name = "PipelineAbortError";
    this.landing = landing;
  }
}

export function isPipelineAbortError(error: unknown): error is PipelineAbortError {
  return error instanceof PipelineAbortError;
}

async function cleanupTempFiles(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => cleanupAudioWriteResidue(p)));
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("Downloaded audio was empty.");
  return bytes;
}

function markersFromGate3(gate3: Gate3Result): MusicSectionMarker[] {
  return gate3.markers;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "Unknown error");
}

/** Map an error onto the fatal gate for terminal logging / abort landing. */
export function classifyPipelineFailedGate(error: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const message = errorMessage(error);
  const gateMatch = message.match(/Gate\s*([1-6])(?:\/6)?/i);
  if (gateMatch) {
    const n = Number(gateMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    if (n >= 1 && n <= 6) return n;
  }
  if (/AIMusicAPI|empty audio buffer|Gate 1/i.test(message)) return 1;
  if (/Supabase|vault|public HTTPS CDN|Gate 2/i.test(message)) return 2;
  if (/CWALO|Gate 3/i.test(message)) return 3;
  if (/Demucs|stem separation|Gate 4/i.test(message)) return 4;
  if (/Fish|vocal conversion|Gate 5/i.test(message)) return 5;
  return 6;
}

function isHttpOrTimeoutFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    /timed\s?out|timeout|Circuit Breaker/i.test(message) ||
    /HTTP\s*[45]\d\d/i.test(message) ||
    /\b(401|403|404|408|429|500|502|503|504)\b/.test(message) ||
    /4xx|5xx|status\s*[45]\d\d/i.test(message)
  );
}

async function applyDefaultCwaloStructure(
  trackId: string,
  durationSeconds: number | undefined,
): Promise<{
  gate3: Gate3Result;
  masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan;
  remuxGains: { instrumentalVolume: number; vocalVolume: number };
}> {
  const gate3 = generateDefaultStructure(durationSeconds ?? 180, trackId);
  const { buildCwaloMasterPlan } = await import("@/lib/cwalo-structure.server");
  const masterPlan = buildCwaloMasterPlan({
    sections: gate3.markers.map((m) => ({ start: m.start, end: m.end, label: m.label })),
    bpm: gate3.bpm ?? null,
    beats: [],
    downbeats: [],
    energyProfile: gate3.markers.map((m) => m.energyLevel ?? 0.7),
    durationSeconds: gate3.markers.at(-1)?.end ?? null,
    outroStart: gate3.markers.find((m) => m.label === "outro")?.start ?? null,
    trackEnd: gate3.markers.at(-1)?.end ?? null,
  });
  return { gate3, masterPlan, remuxGains: masterPlan.remux };
}

/**
 * --- 6-GATE EXECUTION PIPELINE ---
 */
export async function executePipeline(
  trackIdOrInput: string | ExecutePipelineInput,
  prompt?: string,
  style?: string,
): Promise<ExecutePipelineSuccess> {
  const input: ExecutePipelineInput =
    typeof trackIdOrInput === "string"
      ? {
          trackId: trackIdOrInput,
          prompt: prompt ?? "",
          style: style ?? "",
          userId: "system",
        }
      : trackIdOrInput;

  const { trackId } = input;
  if (!acquireTrackLock(trackId)) {
    throw new TrackLockConflictError(trackId);
  }

  const tmpFiles: string[] = [];
  const residue = new ResidueCleanup();
  const startedAt = Date.now();
  let telemetry = createGateTelemetry({ currentGate: 1, stage: "gate_1_generating" });
  const fallbacksUsed: string[] = [];
  const wantsVocals = !input.instrumental && Boolean(input.lyrics?.trim());
  let activeGate: 1 | 2 | 3 | 4 | 5 | 6 = 1;

  try {
    try {
      await safeUpdateTrackStatus({
        trackId,
        userId: input.userId,
        status: "processing",
      });

      const supabase = createEngineSupabaseClient();
      if (!supabase) {
        throw new Error("[Gate 2 Error] Missing Supabase admin client for vault upload.");
      }

      // ── Gate 1: Base Generation (AIMusicAPI) ─────────────────────────────
      activeGate = 1;
      telemetry = safeBumpTelemetry(telemetry, 1, "gate_1_generating");
      await beforeGate({ trackId, gate: 1, stage: "gate_1_generating" });

      let rawAudioBuffer: Buffer;
      if (input.gate1AudioUrl) {
        rawAudioBuffer = await withTimeout(
          downloadBuffer(input.gate1AudioUrl),
          GATE_TIMEOUTS_MS[1],
          "Gate 1 (AIMusicAPI)",
        );
      } else {
        const { generateStudioTrack, waitForStudioTrack } = await import(
          "@/lib/music-generation"
        );
        const started = await withTimeout(
          generateStudioTrack({
            genre: input.style || input.prompt,
            lyrics: input.instrumental ? "" : input.lyrics ?? input.prompt,
            title: input.title || "Studio Master",
            isInstrumental: Boolean(input.instrumental),
            mv: "sonic-v5",
            tags: input.style || undefined,
          }),
          GATE_TIMEOUTS_MS[1],
          "Gate 1 (AIMusicAPI create)",
        );
        const finished = await withTimeout(
          waitForStudioTrack(input.gate1TaskId ?? started.taskId),
          GATE_TIMEOUTS_MS[1],
          "Gate 1 (AIMusicAPI)",
        );
        if (!finished.audioUrl) {
          throw new Error("[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.");
        }
        rawAudioBuffer = await downloadBuffer(finished.audioUrl);
      }
      residue.trackBuffer(rawAudioBuffer);
      await afterGate({ trackId, gate: 1, stage: "gate_1_generating" }, "audio buffer ready");

      // ── Gate 2: Supabase Storage & Public CDN Link ───────────────────────
      activeGate = 2;
      telemetry = safeBumpTelemetry(telemetry, 2, "gate_2_vaulting");
      await beforeGate({ trackId, gate: 2, stage: "gate_2_vaulting" });
      const rawPath = `raw/${trackId.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp3`;
      await withTimeout(
        (async () => {
          const { error } = await supabase.storage.from(AUDIO_VAULT_BUCKET).upload(
            rawPath,
            rawAudioBuffer,
            { contentType: "audio/mpeg", upsert: true },
          );
          if (error) throw new Error(`[Gate 2 Error] ${error.message}`);
        })(),
        GATE_TIMEOUTS_MS[2],
        "Gate 2 (Supabase Upload)",
      );
      const {
        data: { publicUrl: publicAudioUrl },
      } = supabase.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(rawPath);
      if (
        !publicAudioUrl ||
        !publicAudioUrl.startsWith("http") ||
        !isPublicHttpAudioUrl(publicAudioUrl)
      ) {
        throw new Error("[Gate 2 Error] Failed to generate a public HTTPS CDN URL.");
      }
      await afterGate(
        { trackId, gate: 2, stage: "gate_2_vaulting" },
        `cdn=${publicAudioUrl.slice(0, 64)}`,
      );

      // ── Gate 3: CWALO with Fallback Detour ───────────────────────────────
      activeGate = 3;
      telemetry = safeBumpTelemetry(telemetry, 3, "gate_3_analyzing");
      await beforeGate({ trackId, gate: 3, stage: "gate_3_analyzing" });
      let cwaloOutput: Gate3Result | null = null;
      let masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null = null;
      let remuxGains = { instrumentalVolume: 1.0, vocalVolume: 1.0 };
      try {
        const { analyzeMusicStructureWithCwalo } = await import("@/lib/cwalo-structure.server");
        const structure = await withTimeout(
          analyzeMusicStructureWithCwalo(publicAudioUrl),
          GATE_TIMEOUTS_MS[3],
          "Gate 3 (CWALO)",
        );
        remuxGains = structure.remux;
        masterPlan = structure.masterPlan;
        cwaloOutput = {
          trackId,
          isFallback: false,
          markers: structure.sections.map((s) => ({
            label: (["intro", "verse", "chorus", "bridge", "solo", "outro"].includes(
              s.label.trim().toLowerCase().split(/\s+/)[0] ?? "",
            )
              ? (s.label.trim().toLowerCase().split(/\s+/)[0] as MusicSectionMarker["label"])
              : "verse"),
            start: s.start,
            end: s.end,
          })),
          bpm: structure.bpm ?? undefined,
        };
      } catch (err) {
        const detail = errorMessage(err);
        console.warn(
          `[Gate 3 Fallback] Replicate CWALO rejected or timed out (${detail}). ` +
            `Assigning cwaloOutput = generateDefaultStructure() and continuing to Gate 4.`,
        );
        const defaults = await applyDefaultCwaloStructure(trackId, input.durationSeconds);
        cwaloOutput = defaults.gate3;
        masterPlan = defaults.masterPlan;
        remuxGains = defaults.remuxGains;
        fallbacksUsed.push(FALLBACK_CWALO_DEFAULT_STRUCTURE);
        telemetry = safeRecordFallback(telemetry, FALLBACK_CWALO_DEFAULT_STRUCTURE);
      }
      // Soft-fail guarantee: never proceed without a structure object.
      if (!cwaloOutput || !masterPlan) {
        const defaults = await applyDefaultCwaloStructure(trackId, input.durationSeconds);
        cwaloOutput = defaults.gate3;
        masterPlan = defaults.masterPlan;
        remuxGains = defaults.remuxGains;
      }
      await afterGate(
        { trackId, gate: 3, stage: "gate_3_analyzing" },
        cwaloOutput.isFallback ? "default structure" : "cwalo ok",
      );

      // ── Gate 4: Demucs ───────────────────────────────────────────────────
      activeGate = 4;
      telemetry = safeBumpTelemetry(telemetry, 4, "gate_4_splitting");
      await beforeGate({ trackId, gate: 4, stage: "gate_4_splitting" });
      const { separateStemsFromPublicUrl } = await import("@/lib/stems.server");
      let demucsOutput: Awaited<ReturnType<typeof separateStemsFromPublicUrl>>;
      try {
        demucsOutput = await withTimeout(
          separateStemsFromPublicUrl(publicAudioUrl),
          GATE_TIMEOUTS_MS[4],
          "Gate 4 (Demucs)",
        );
      } catch (err) {
        throw new Error(`[Gate 4 Error] Demucs stem separation failed: ${errorMessage(err)}`);
      }
      const vocalStemUrl = demucsOutput.vocals;
      const backingStemUrlValue = backingStemUrl(demucsOutput);
      if (wantsVocals && (!vocalStemUrl || !backingStemUrlValue)) {
        throw new Error(
          "[Gate 4 Error] Missing split stems in Demucs payload (vocals / no_vocals).",
        );
      }
      await afterGate({ trackId, gate: 4, stage: "gate_4_splitting" }, "stems ready");

      // ── Gate 5: Fish Audio with Fallback Detour ──────────────────────────
      activeGate = 5;
      telemetry = safeBumpTelemetry(telemetry, 5, "gate_5_converting");
      await beforeGate({ trackId, gate: 5, stage: "gate_5_converting" });
      let mixVocalUrl: string | null = null;
      let convertedVocalBuffer: Buffer | null = null;

      if (wantsVocals && vocalStemUrl) {
        try {
          const { convertVocalsWithStems } = await import("@/lib/fish-tts.server");
          const isolatedVocal = await downloadBuffer(vocalStemUrl);
          residue.trackBuffer(isolatedVocal);
          const converted = await withTimeout(
            convertVocalsWithStems({
              lyrics: input.lyrics ?? input.prompt,
              isolatedVocal,
              referenceAudio: input.referenceSampleUrl
                ? await downloadBuffer(input.referenceSampleUrl)
                : undefined,
              audioFormat: input.audioFormat,
              title: `${input.title ?? "Studio"} vocals`,
              userId: input.userId,
              taskId: `${trackId}-fish-vocals`,
              language: input.language,
              customLanguage: input.customLanguage,
            }),
            GATE_TIMEOUTS_MS[5],
            "Gate 5 (Fish Audio)",
          );
          mixVocalUrl = converted.tracks.find((t) => t.audioUrl)?.audioUrl ?? null;
          if (!mixVocalUrl) {
            throw new Error("Empty vocal conversion buffer (no audioUrl).");
          }
        } catch (err) {
          const detail = errorMessage(err);
          const kind = isHttpOrTimeoutFailure(err)
            ? "timeout/4xx/5xx"
            : "conversion failure";
          console.warn(
            `[Gate 5 Fallback] Fish Audio ${kind}: ${detail}. ` +
              `Falling back to fetchRawVocalFallback() (raw Demucs vocal stem).`,
          );
          try {
            const fallbackResult = await fetchRawVocalFallback(vocalStemUrl, trackId);
            convertedVocalBuffer = fallbackResult.convertedVocalBuffer;
            residue.trackBuffer(convertedVocalBuffer);
            mixVocalUrl = vocalStemUrl;
            fallbacksUsed.push(FALLBACK_FISH_AUDIO_RAW_VOCALS);
            telemetry = safeRecordFallback(telemetry, FALLBACK_FISH_AUDIO_RAW_VOCALS);
          } catch (fallbackErr) {
            throw new Error(
              `[Gate 5 Error] Fish Audio failed and Demucs vocal fallback also failed: ${errorMessage(fallbackErr)}`,
            );
          }
        }
      }

      const mixInstrumentalUrl =
        backingStemUrlValue ?? (wantsVocals ? null : publicAudioUrl);
      if (wantsVocals && (!mixVocalUrl || !mixInstrumentalUrl)) {
        throw new Error("[Gate 5 Error] Missing vocal or backing stem for remux.");
      }
      await afterGate(
        { trackId, gate: 5, stage: "gate_5_converting" },
        mixVocalUrl ? "vocals ready" : "instrumental path",
      );

      // ── Gate 6: FFmpeg Mastering & Final Vault Upload ────────────────────
      activeGate = 6;
      telemetry = safeBumpTelemetry(telemetry, 6, "gate_6_mastering");
      await beforeGate({ trackId, gate: 6, stage: "gate_6_mastering" });
      const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
      let mastered: Awaited<ReturnType<typeof mixAndMasterHybridTrack>>;
      try {
        mastered = await withTimeout(
          mixAndMasterHybridTrack({
            introUrl: null,
            instrumentalUrl: mixInstrumentalUrl,
            vocalUrl: mixVocalUrl,
            userId: input.userId,
            taskId: trackId,
            maxSeconds: input.durationSeconds,
            remuxGains: {
              ...remuxGains,
              instrumentalVolumeExpr: masterPlan.instrumentalVolumeExpr,
              vocalVolumeExpr: masterPlan.vocalVolumeExpr,
            },
            cwaloGuide: {
              trackEnd: masterPlan.trackEnd ?? undefined,
              outroStart: masterPlan.outroStart ?? undefined,
              fadeOutSeconds: masterPlan.fadeOutSeconds,
              sectionCount: masterPlan.sections.length,
            },
          }),
          GATE_TIMEOUTS_MS[6],
          "Gate 6 (FFmpeg Remux)",
        );
      } catch (err) {
        throw new Error(`[Gate 6 Error] FFmpeg remux failed: ${errorMessage(err)}`);
      }

      if (!mastered.masterUrl || !mastered.mixed) {
        throw new Error("[Gate 6 Error] Mastering did not produce a playable master.");
      }

      let finalMasterUrl = mastered.masterUrl;
      try {
        const masterBuffer = await downloadBuffer(mastered.masterUrl);
        residue.trackBuffer(masterBuffer);
        const masterPath = `masters/${trackId.replace(/[^a-zA-Z0-9_-]/g, "_")}_master.wav`;
        await withTimeout(
          (async () => {
            const { error } = await supabase.storage.from(AUDIO_VAULT_BUCKET).upload(
              masterPath,
              masterBuffer,
              { contentType: "audio/wav", upsert: true },
            );
            if (error) throw new Error(error.message);
          })(),
          30_000,
          "Gate 6 (Supabase Master Upload)",
        );
        const {
          data: { publicUrl },
        } = supabase.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(masterPath);
        if (publicUrl?.startsWith("http")) finalMasterUrl = publicUrl;
      } catch (err) {
        console.warn(
          "[Gate 6] WAV re-vault skipped — using mastering CDN URL",
          errorMessage(err),
        );
      }

      await afterGate({ trackId, gate: 6, stage: "gate_6_mastering" }, "master ready");
      await runSafeHook("pipeline success log", () => {
        console.log(`[Pipeline Success] Master ready at: ${finalMasterUrl}`);
      });
      telemetry = safeBumpTelemetry(
        telemetry,
        6,
        fallbacksUsed.length ? "landing_fallback" : "landing_success",
      );

      return {
        status: fallbacksUsed.length ? "completed_fallback" : "success",
        trackId,
        masterUrl: finalMasterUrl,
        duration: input.durationSeconds ?? cwaloOutput.markers.at(-1)?.end ?? 0,
        structuralMarkers: markersFromGate3(cwaloOutput),
        fallbacksUsed,
        executionTimeMs: Date.now() - startedAt,
        vocalUrl: mixVocalUrl,
        instrumentalUrl: mixInstrumentalUrl,
        publicAudioUrl,
        mixed: mastered.mixed,
        matched: mastered.matched,
      };
    } catch (error) {
      // Outer abort landing — soft-fail gates (3/5) never reach here for their detours.
      if (error instanceof TrackLockConflictError || error instanceof PipelineAbortError) {
        throw error;
      }
      const failedGate = classifyPipelineFailedGate(error) || activeGate;
      const message = errorMessage(error);
      await runSafeHook("pipeline fail log", () => {
        console.error(
          `[Pipeline Failed] Gate ${failedGate}/6 aborted for track ${trackId}: ${message}`,
        );
      });
      telemetry = safeBumpTelemetry(telemetry, failedGate, "landing_aborted");
      await safeUpdateTrackStatus({
        trackId,
        userId: input.userId,
        status: "failed",
        reason: message,
      });
      const landing: LandingAbortResponse = {
        status: "failed",
        trackId,
        failedGate: `Gate ${failedGate}`,
        error: message,
        executionTimeMs: Date.now() - startedAt,
      };
      throw new PipelineAbortError(landing);
    }
  } finally {
    // Unconditional cleanup — each step isolated so one failure cannot skip the rest.
    try {
      releaseTrackLock(trackId);
    } catch (lockErr) {
      console.warn(`[Pipeline Cleanup] releaseTrackLock: ${errorMessage(lockErr)}`);
    }
    try {
      await residue.dispose();
    } catch (residueErr) {
      console.warn(`[Pipeline Cleanup] residue.dispose: ${errorMessage(residueErr)}`);
    }
    try {
      await cleanupTempFiles(...tmpFiles);
    } catch (tmpErr) {
      console.warn(`[Pipeline Cleanup] cleanupTempFiles: ${errorMessage(tmpErr)}`);
    }
  }
}

export type { PipelineResponse };
