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
} from "@/lib/pipeline-fallbacks.server";
import { ResidueCleanup } from "@/lib/six-gate-landing.server";
import { backingStemUrl } from "@/lib/stem-urls";
import {
  acquireTrackLock,
  releaseTrackLock,
  releaseAllTrackLocks,
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
import {
  PipelineGate,
  PIPELINE_COMPLETE,
  canExecuteVocals,
  chargeLineItem,
  getGateNameFromFlag,
  hasPassedGate,
  passGate,
  percentFromGateMask,
  progressStageFromGateFlag,
  type ChargeLedgerEntry,
} from "@/lib/pipeline-flags";
import { reportPipelineProgress, PIPELINE_PROGRESS } from "@/lib/pipeline-progress";
import { executePostBinarySettlement } from "@/lib/pipeline-settlement.server";
import { ffmpegMasteringFilter } from "@/lib/loudnorm";
import {
  purgeTempBuffers,
  releaseWorkerSlot,
} from "@/lib/pipeline-worker.server";
import {
  abortActiveGenerationRuns,
  voidPendingTokenReservations,
} from "@/lib/pipeline-idempotency.server";

// Re-export for Gate 6 callers / tests that import from the orchestrator module.
export { ffmpegMasteringFilter };

// ── Graceful process exit traps ──────────────────────────────────────────────
let osGuardsInstalled = false;

const cleanupActiveSlot = () => {
  try {
    releaseWorkerSlot();
    void purgeTempBuffers();
    releaseAllTrackLocks();
    voidPendingTokenReservations();
    abortActiveGenerationRuns();
  } catch (err) {
    console.error("Error during emergency process cleanup:", err);
  }
};

/** Idempotent — register SIGTERM/SIGINT once for emergency slot/tmp cleanup. */
export function installPipelineOsGuards(): void {
  if (osGuardsInstalled || typeof process === "undefined" || typeof process.once !== "function") {
    return;
  }
  osGuardsInstalled = true;
  process.once("SIGTERM", () => {
    console.warn("[Pipeline OS Guard] SIGTERM — emergency cleanup");
    cleanupActiveSlot();
    process.exit(0);
  });
  process.once("SIGINT", () => {
    console.warn("[Pipeline OS Guard] SIGINT — emergency cleanup");
    cleanupActiveSlot();
    process.exit(0);
  });
}

installPipelineOsGuards();

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
  /** True when post-binary settlement debited Hybrid Tokens server-side. */
  tokenSettled?: boolean;
  settlement?: {
    status: "settled" | "rolled_back";
    gateMask: number;
    finalGateMask: number;
    tokenSettled: boolean;
    chargeLedger?: ChargeLedgerEntry[];
    totalCharged?: number;
  };
  chargeLedger?: ChargeLedgerEntry[];
  totalCharged?: number;
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

/**
 * Strip inherited Gate 1 circuit-breaker wording (e.g. "timed out after 150s")
 * so Gate 4/5 failures never surface as AIMusicAPI timeouts.
 */
function sanitizeInheritedGate1Message(message: string): string {
  return message
    .replace(/\[Circuit Breaker\]\s*Gate\s*1[^\n]*/gi, "")
    .replace(/Gate\s*1\s*\(AIMusicAPI[^)]*\)/gi, "")
    .replace(/AIMusicAPI[^.\n]*/gi, "")
    .replace(/timed out after 150s/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function gateStepError(gate: 4 | 5, stepLabel: string, error: unknown): Error {
  const cleaned = sanitizeInheritedGate1Message(errorMessage(error));
  return new Error(
    `[Gate ${gate}] ${stepLabel}${cleaned ? `: ${cleaned}` : " failed"}`,
  );
}

/** Map an error onto the fatal gate for terminal logging / abort landing. */
export function classifyPipelineFailedGate(
  error: unknown,
  currentStep?: string,
): 1 | 2 | 3 | 4 | 5 | 6 {
  // Prefer the active soft step so nested throws never inherit Gate 1 labels.
  if (currentStep === "vocals") return 5;
  if (currentStep === "master") return 6;
  if (currentStep === "demux" || currentStep === "stems") return 4;
  if (currentStep === "cwalo") return 3;
  if (currentStep === "vault") return 2;
  if (currentStep === "composition" || currentStep === "music") return 1;

  const message = errorMessage(error);
  const gateMatch = message.match(/Gate\s*([1-6])(?:\/6)?/i);
  if (gateMatch) {
    const n = Number(gateMatch[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    if (n >= 1 && n <= 6) return n;
  }
  if (/AIMusicAPI|empty audio buffer|Gate 1/i.test(message) && !/Gate\s*[45]/i.test(message)) {
    return 1;
  }
  if (/Supabase|vault|public HTTPS CDN|Gate 2/i.test(message)) return 2;
  if (/CWALO|Gate 3/i.test(message)) return 3;
  if (/Demucs|demux|stem separation|Gate 4/i.test(message)) return 4;
  if (/Fish|vocal conversion|Gate 5/i.test(message)) return 5;
  return 6;
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
  /** Soft progress step — Gate 1=`composition`, Gate 4=`demux`, Gate 5=`vocals`. */
  let currentStep: string = "composition";
  let gateMask: number = PipelineGate.NONE;
  const chargeLedger: ChargeLedgerEntry[] = [];

  const emitGateProgress = (justPassed: number) => {
    const stage = progressStageFromGateFlag(justPassed);
    const percent = percentFromGateMask(gateMask);
    void runSafeHook(`progress ${getGateNameFromFlag(justPassed)}`, () => {
      reportPipelineProgress(stage, percent || PIPELINE_PROGRESS.sonic, undefined, gateMask);
    });
  };

  /** Sequential line charger — records billable compute as each gate completes. */
  const billGate = (gateFlag: number) => {
    chargeLineItem(chargeLedger, gateFlag);
  };

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
      currentStep = "composition";
      telemetry = safeBumpTelemetry(telemetry, 1, "gate_1_generating");
      await beforeGate({ trackId, gate: 1, stage: "gate_1_generating" });
      reportPipelineProgress("composition", PIPELINE_PROGRESS.sonic, undefined, gateMask);
      console.log("[Gate 1/6] currentStep=composition — AIMusicAPI create/poll");

      let rawAudioBuffer: Buffer;
      if (input.gate1AudioUrl) {
        try {
          rawAudioBuffer = await withTimeout(
            downloadBuffer(input.gate1AudioUrl),
            GATE_TIMEOUTS_MS[1],
            "Gate 1 (AIMusicAPI)",
            { step: "composition" },
          );
        } catch (err) {
          const e = new Error(
            errorMessage(err) ||
              `[Circuit Breaker] Gate 1 (AIMusicAPI) timed out after ${GATE_TIMEOUTS_MS[1] / 1000}s`,
          ) as Error & { step: string };
          e.step = "composition";
          throw e;
        }
      } else {
        const { generateStudioTrack, waitForStudioTrack } = await import(
          "@/lib/music-generation"
        );
        try {
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
            { step: "composition" },
          );
          const finished = await withTimeout(
            waitForStudioTrack(input.gate1TaskId ?? started.taskId),
            GATE_TIMEOUTS_MS[1],
            "Gate 1 (AIMusicAPI)",
            { step: "composition" },
          );
          if (!finished.audioUrl) {
            const empty = new Error(
              "[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.",
            ) as Error & { step: string };
            empty.step = "composition";
            throw empty;
          }
          rawAudioBuffer = await downloadBuffer(finished.audioUrl);
        } catch (err) {
          if (err && typeof err === "object" && "step" in err) throw err;
          const e = new Error(errorMessage(err)) as Error & { step: string };
          e.step = "composition";
          throw e;
        }
      }
      residue.trackBuffer(rawAudioBuffer);
      gateMask = passGate(gateMask, PipelineGate.COMPOSITION);
      emitGateProgress(PipelineGate.COMPOSITION);
      billGate(PipelineGate.COMPOSITION);
      await afterGate({ trackId, gate: 1, stage: "gate_1_generating" }, "audio buffer ready");

      // ── Gate 2: Supabase Storage & Public CDN Link ───────────────────────
      if (!hasPassedGate(gateMask, PipelineGate.COMPOSITION)) {
        throw new Error("[Gate 2] Prerequisite failed: COMPOSITION bit not set.");
      }
      activeGate = 2;
      currentStep = "vault";
      telemetry = safeBumpTelemetry(telemetry, 2, "gate_2_vaulting");
      await beforeGate({ trackId, gate: 2, stage: "gate_2_vaulting" });
      reportPipelineProgress("vault", PIPELINE_PROGRESS.vault, undefined, gateMask);
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
      gateMask = passGate(gateMask, PipelineGate.STORAGE);
      emitGateProgress(PipelineGate.STORAGE);

      // ── Gate 3: CWALO with Fallback Detour ───────────────────────────────
      if (!hasPassedGate(gateMask, PipelineGate.STORAGE)) {
        throw new Error("[Gate 3] Prerequisite failed: STORAGE bit not set.");
      }
      activeGate = 3;
      currentStep = "cwalo";
      telemetry = safeBumpTelemetry(telemetry, 3, "gate_3_analyzing");
      await beforeGate({ trackId, gate: 3, stage: "gate_3_analyzing" });
      reportPipelineProgress("cwalo", PIPELINE_PROGRESS.cwalo, undefined, gateMask);
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
      // Soft-fail guarantee: CWALO must never block Demucs — always continue to Gate 4.
      if (!cwaloOutput || !masterPlan) {
        const defaults = await applyDefaultCwaloStructure(trackId, input.durationSeconds);
        cwaloOutput = defaults.gate3;
        masterPlan = defaults.masterPlan;
        remuxGains = defaults.remuxGains;
      }
      await afterGate(
        { trackId, gate: 3, stage: "gate_3_analyzing" },
        cwaloOutput.isFallback ? "default structure → Gate 4" : "cwalo ok → Gate 4",
      );
      // Soft-fail still marks STRUCTURE so Demucs can proceed with a known plan.
      gateMask = passGate(gateMask, PipelineGate.STRUCTURE);
      emitGateProgress(PipelineGate.STRUCTURE);

      // ── Gate 4: Demucs (ryan5453/demucs) — ALWAYS after Gate 2 CDN URL ───
      // Runs whether Gate 3 succeeded or soft-failed. Must complete before Gate 5.
      if (!hasPassedGate(gateMask, PipelineGate.STORAGE)) {
        throw new Error("[Gate 4] Prerequisite failed: STORAGE bit not set.");
      }
      activeGate = 4;
      currentStep = "demux";
      telemetry = safeBumpTelemetry(telemetry, 4, "gate_4_splitting");
      await beforeGate({ trackId, gate: 4, stage: "gate_4_splitting" });
      reportPipelineProgress("stems", PIPELINE_PROGRESS.stems, undefined, gateMask);
      console.log(
        `[Gate 4/6] Demucs stem separation (ryan5453/demucs) on Gate 2 CDN URL…`,
      );

      let vocalStemUrl: string | null = null;
      let instrumentalStemUrl: string | null = null;

      try {
        const { separateStemsFromPublicUrl } = await import("@/lib/stems.server");
        if (!isPublicHttpAudioUrl(publicAudioUrl)) {
          throw new Error("Gate 2 public CDN URL is required before Demucs.");
        }
        const demucsOutput = await withTimeout(
          separateStemsFromPublicUrl(publicAudioUrl),
          GATE_TIMEOUTS_MS[4],
          "Gate 4 (Demucs / ryan5453/demucs)",
        );
        vocalStemUrl = demucsOutput.vocals;
        instrumentalStemUrl = backingStemUrl(demucsOutput);
      } catch (err) {
        // Never surface Gate 1's 150s AIMusicAPI breaker wording here.
        throw new Error(
          `[Gate 4] Stem Separation Failed${
            sanitizeInheritedGate1Message(errorMessage(err))
              ? `: ${sanitizeInheritedGate1Message(errorMessage(err))}`
              : ""
          }`,
        );
      }

      if (wantsVocals && !vocalStemUrl) {
        throw new Error(
          "[Gate 4] Stem Separation Failed: Demucs did not return an isolated vocal stem URL.",
        );
      }
      if (wantsVocals && !instrumentalStemUrl) {
        console.warn(
          "[Gate 4] Missing instrumental/no_vocals stem — falling back to Gate 2 master mix for remux backing.",
        );
        instrumentalStemUrl = publicAudioUrl;
      }
      if (!wantsVocals) {
        // Instrumental renders: backing is Demucs no_vocals when present, else master mix.
        instrumentalStemUrl = instrumentalStemUrl ?? publicAudioUrl;
      }

      await afterGate(
        { trackId, gate: 4, stage: "gate_4_splitting" },
        `vocals=${Boolean(vocalStemUrl)} instrumental=${Boolean(instrumentalStemUrl)}`,
      );
      gateMask = passGate(gateMask, PipelineGate.DEMUX);
      emitGateProgress(PipelineGate.DEMUX);
      billGate(PipelineGate.DEMUX);

      // ── Gate 5: Fish Audio with Fallback Detour ──────────────────────────
      // Enforce Demucs bit before Fish Audio.
      if (!hasPassedGate(gateMask, PipelineGate.DEMUX) || !canExecuteVocals(gateMask)) {
        throw new Error(
          "[Gate 5] Prerequisite failed: DEMUX bit must be set before vocals.",
        );
      }
      activeGate = 5;
      currentStep = "vocals";
      telemetry = safeBumpTelemetry(telemetry, 5, "gate_5_converting");
      await beforeGate({ trackId, gate: 5, stage: "gate_5_converting" });
      reportPipelineProgress("vocals", PIPELINE_PROGRESS.vocals, undefined, gateMask);

      let mixVocalUrl: string | null = null;
      let vocalAudioBuffer: Buffer | null = null;
      let fishConversionSucceeded = false;
      const mixInstrumentalUrl = instrumentalStemUrl ?? publicAudioUrl;

      if (wantsVocals) {
        // Gate 5 pre-flight: valid Gate 4 vocal URL/buffer required before Fish.
        if (!vocalStemUrl || !isPublicHttpAudioUrl(vocalStemUrl)) {
          throw new Error(
            "[Gate 4] Stem Separation Failed: no isolated vocal stem available for Fish Audio.",
          );
        }

        let rawDemucsVocalBuffer: Buffer;
        try {
          rawDemucsVocalBuffer = await downloadBuffer(vocalStemUrl);
          residue.trackBuffer(rawDemucsVocalBuffer);
        } catch (err) {
          throw gateStepError(4, "Stem Separation Failed (vocal download)", err);
        }

        if (!rawDemucsVocalBuffer.byteLength) {
          // Soft remux path: original Gate 2 master mix instead of null into Fish.
          console.warn(
            "[Gate 5] Empty Demucs vocal buffer — using Gate 2 master mix as vocal fallback for remux.",
          );
          vocalAudioBuffer = null;
          mixVocalUrl = publicAudioUrl;
        } else {
          vocalAudioBuffer = rawDemucsVocalBuffer;
          mixVocalUrl = vocalStemUrl;

          try {
            const { convertVocalsWithStems } = await import("@/lib/fish-tts.server");
            const voiceModelId = `${trackId}-fish-vocals`;
            const converted = await withTimeout(
              (async () => {
                const referenceAudio = input.referenceSampleUrl
                  ? await downloadBuffer(input.referenceSampleUrl)
                  : undefined;
                return convertVocalsWithStems({
                  lyrics: input.lyrics ?? input.prompt,
                  isolatedVocal: rawDemucsVocalBuffer,
                  referenceAudio,
                  audioFormat: input.audioFormat,
                  title: `${input.title ?? "Studio"} vocals`,
                  userId: input.userId,
                  taskId: voiceModelId,
                  language: input.language,
                  customLanguage: input.customLanguage,
                });
              })(),
              GATE_TIMEOUTS_MS[5],
              "Gate 5 (Fish Audio)",
            );
            const fishUrl = converted.tracks.find((t) => t.audioUrl)?.audioUrl ?? null;
            if (!fishUrl) {
              throw new Error("[Gate 5] Fish Audio returned an empty vocal conversion buffer.");
            }
            mixVocalUrl = fishUrl;
            fishConversionSucceeded = true;
            try {
              vocalAudioBuffer = await downloadBuffer(fishUrl);
              residue.trackBuffer(vocalAudioBuffer);
            } catch {
              vocalAudioBuffer = rawDemucsVocalBuffer;
            }
          } catch (err) {
            const detail = sanitizeInheritedGate1Message(
              err instanceof Error ? err.message : String(err ?? "unknown"),
            );
            console.warn(
              "[Gate 5] Fish Audio conversion failed/timed out, falling back to raw vocal stem:",
              detail || errorMessage(err),
            );
            vocalAudioBuffer = rawDemucsVocalBuffer;
            mixVocalUrl = vocalStemUrl;
            fallbacksUsed.push(FALLBACK_FISH_AUDIO_RAW_VOCALS);
            telemetry = safeRecordFallback(telemetry, FALLBACK_FISH_AUDIO_RAW_VOCALS);
          }
        }
      }

      if (wantsVocals && (!mixVocalUrl || !mixInstrumentalUrl)) {
        throw new Error(
          "[Gate 4] Stem Separation Failed: missing vocal or instrumental stem for remux.",
        );
      }
      await afterGate(
        { trackId, gate: 5, stage: "gate_5_converting" },
        mixVocalUrl
          ? fallbacksUsed.includes(FALLBACK_FISH_AUDIO_RAW_VOCALS)
            ? "raw Demucs vocal → Gate 6"
            : mixVocalUrl === publicAudioUrl
              ? "master-mix vocal fallback → Gate 6"
              : "Fish vocals ready"
          : "instrumental path",
      );
      // Instrumental path still sets VOCALS so the complete mask can reach 63.
      gateMask = passGate(gateMask, PipelineGate.VOCALS);
      emitGateProgress(PipelineGate.VOCALS);
      // Bypass line charge when Fish soft-failed to raw Demucs stems (or instrumental skip).
      if (fishConversionSucceeded) {
        billGate(PipelineGate.VOCALS);
      } else if (fallbacksUsed.includes(FALLBACK_FISH_AUDIO_RAW_VOCALS)) {
        console.log(
          "[Line Charger] Bypassed Vocal Model Conversion — soft-failed to raw Demucs stems ($0.00)",
        );
      }

      // ── Gate 6: FFmpeg Mastering & Final Vault Upload ────────────────────
      if (!hasPassedGate(gateMask, PipelineGate.VOCALS)) {
        throw new Error("[Gate 6] Prerequisite failed: VOCALS bit not set.");
      }
      activeGate = 6;
      currentStep = "master";
      telemetry = safeBumpTelemetry(telemetry, 6, "gate_6_mastering");
      await beforeGate({ trackId, gate: 6, stage: "gate_6_mastering" });
      reportPipelineProgress("master", PIPELINE_PROGRESS.master, undefined, gateMask);
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
      gateMask = passGate(gateMask, PipelineGate.MASTERING);
      emitGateProgress(PipelineGate.MASTERING);
      billGate(PipelineGate.MASTERING);

      const duration = input.durationSeconds ?? cwaloOutput.markers.at(-1)?.end ?? 0;
      const structuralMarkers = markersFromGate3(cwaloOutput);

      // Post-binary settlement — only when every gate bit is set (63).
      const settlement = await executePostBinarySettlement({
        gateMask,
        trackId,
        userId: input.userId,
        masterUrl: finalMasterUrl,
        vocalUrl: mixVocalUrl,
        instrumentalUrl: mixInstrumentalUrl,
        publicAudioUrl,
        structuralMarkers,
        duration,
        title: input.title,
        idempotencyKey: `pipeline:${trackId}`,
        chargeLedger,
        residue,
        tmpPaths: tmpFiles,
      });

      if (!settlement.ok || gateMask !== PIPELINE_COMPLETE) {
        throw new Error(
          `[Settlement] Incomplete binary mask 0b${gateMask.toString(2)} (${gateMask}); rolled back with zero charge.`,
        );
      }

      await runSafeHook("pipeline success log", () => {
        console.log(
          `[Pipeline Success] Master ready at: ${finalMasterUrl} gateMask=${gateMask} totalCharged=$${settlement.ui.totalCharged.toFixed(2)} tokenSettled=${settlement.ui.tokenSettled}`,
        );
      });
      telemetry = safeBumpTelemetry(
        telemetry,
        6,
        fallbacksUsed.length ? "landing_fallback" : "landing_success",
      );

      return {
        status: fallbacksUsed.length ? "completed_fallback" : "success",
        trackId,
        masterUrl: settlement.ui.masterUrl ?? finalMasterUrl,
        duration: settlement.ui.duration || duration,
        structuralMarkers: settlement.ui.structuralMarkers,
        fallbacksUsed,
        executionTimeMs: Date.now() - startedAt,
        pipelineState: gateMask,
        vocalUrl: settlement.ui.vocalUrl ?? mixVocalUrl,
        instrumentalUrl: settlement.ui.instrumentalUrl ?? mixInstrumentalUrl,
        publicAudioUrl,
        mixed: mastered.mixed,
        matched: mastered.matched,
        tokenSettled: settlement.ui.tokenSettled,
        settlement: settlement.ui,
        chargeLedger: settlement.ui.chargeLedger,
        totalCharged: settlement.ui.totalCharged,
      };
    } catch (error) {
      // Outer abort landing — soft-fail gates (3/5) never reach here for their detours.
      if (error instanceof TrackLockConflictError || error instanceof PipelineAbortError) {
        throw error;
      }
      const failedGate = classifyPipelineFailedGate(error, currentStep) || activeGate;
      const rawMessage = errorMessage(error);
      const message =
        failedGate === 1
          ? rawMessage
          : sanitizeInheritedGate1Message(rawMessage) || rawMessage;
      await runSafeHook("pipeline fail log", () => {
        console.error(
          `[Pipeline Failed] Gate ${failedGate}/6 aborted for track ${trackId}: ${message} gateMask=0b${gateMask.toString(2)}`,
        );
      });
      telemetry = safeBumpTelemetry(telemetry, failedGate, "landing_aborted");
      // Zero-charge rollback path — incomplete mask never debits tokens.
      const { executeZeroChargeRollback } = await import("@/lib/pipeline-settlement.server");
      await executeZeroChargeRollback({
        gateMask,
        trackId,
        userId: input.userId,
        reason: message,
        residue,
        tmpPaths: tmpFiles,
      }).catch(() => undefined);
      const landing: LandingAbortResponse = {
        status: "failed",
        trackId,
        failedGate: `Gate ${failedGate}`,
        error: message,
        executionTimeMs: Date.now() - startedAt,
        pipelineState: gateMask,
      };
      throw new PipelineAbortError(landing);
    }
  } finally {
    // Unconditional cleanup — each step isolated so one failure cannot skip the rest.
    // Settlement may have already disposed residue; these calls are idempotent / soft.
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
