/**
 * Canonical pipeline execution — circuit breakers + unlock/cleanup in finally.
 *
 * Production default: Gate 1 → Gate 2 → Gate 6 (master Gate 2 vault audio).
 * Gates 3–5 (CWALO / Demucs / RVC) remain behind HYBRID_ENABLE_STEM_PIPELINE=1.
 */

import { AUDIO_VAULT_BUCKET, resolveAudioVaultBucket } from "@/lib/audio-vault";
import { ensureAudioVaultBucket } from "@/lib/audio-vault-ensure.server";
import { requireSupabaseAdmin } from "@/integrations/supabase/client.server";
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
  /**
   * Artist RVC v2 model zip URL (HTTPS). When set (or via RVC_MODEL_DOWNLOAD_URL),
   * Gate 5 runs zsxkib/realistic-voice-cloning with pitch preservation.
   */
  rvcModelUrl?: string;
  audioFormat?: "mp3" | "wav";
  title?: string;
  durationSeconds?: number;
  language?: string;
  customLanguage?: string;
  /** Ledger key for Hybrid Token burn (must match authorize-at-queue). */
  tokenIdempotencyKey?: string;
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
 * Strip inherited Gate 1 circuit-breaker wording (e.g. "timed out after 300s")
 * so Gate 4/5 failures never surface as AIMusicAPI timeouts.
 */
function sanitizeInheritedGate1Message(message: string): string {
  return message
    .replace(/\[Circuit Breaker\]\s*Gate\s*1[^\n]*/gi, "")
    .replace(/Gate\s*1\s*\(AIMusicAPI[^)]*\)/gi, "")
    .replace(/AIMusicAPI[^.\n]*/gi, "")
    .replace(/timed out after \d+s/gi, "")
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

      // Prisma Track row — soft-fail so missing DATABASE_URL never blocks Gate 1.
      await runSafeHook("prisma upsert Track", async () => {
        const { upsertPipelineTrack } = await import("@/lib/prisma.server");
        await upsertPipelineTrack({
          id: trackId,
          title: input.title || "Studio Master",
          prompt: input.prompt || input.style || "",
          status: "PROCESSING",
          gateMask: 0,
        });
      });

      const supabaseAdmin = requireSupabaseAdmin();

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
      await runSafeHook("prisma patch Gate 1", async () => {
        const { patchPipelineTrack } = await import("@/lib/prisma.server");
        await patchPipelineTrack(trackId, {
          status: "COMPOSITION_DONE",
          gateMask,
        });
      });

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
      const vaultBucket = resolveAudioVaultBucket() || AUDIO_VAULT_BUCKET;
      await ensureAudioVaultBucket(supabaseAdmin, vaultBucket);
      console.log(`[Gate 2/6] Vault ingest via supabaseAdmin → ${vaultBucket}/${rawPath}`);
      await withTimeout(
        (async () => {
          try {
            const { error } = await supabaseAdmin.storage.from(vaultBucket).upload(
              rawPath,
              rawAudioBuffer,
              { contentType: "audio/mpeg", upsert: true, cacheControl: "31536000" },
            );
            if (error) {
              console.error(
                `[Gate 2 Error] Supabase vault upload failed (bucket=${vaultBucket}):`,
                error.message,
                error,
              );
              throw new Error(`[Gate 2 Error] ${error.message}`);
            }
          } catch (uploadErr) {
            if (uploadErr instanceof Error && uploadErr.message.startsWith("[Gate 2 Error]")) {
              throw uploadErr;
            }
            console.error("[Gate 2 Error] Unexpected vault upload failure:", uploadErr);
            throw new Error(
              `[Gate 2 Error] ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`,
            );
          }
        })(),
        GATE_TIMEOUTS_MS[2],
        "Gate 2 (Supabase Upload)",
      );
      const {
        data: { publicUrl: publicAudioUrl },
      } = supabaseAdmin.storage.from(vaultBucket).getPublicUrl(rawPath);
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

      let cwaloOutput: Gate3Result | null = null;
      let masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null = null;
      let remuxGains = { instrumentalVolume: 1.0, vocalVolume: 1.0 };
      let mixVocalUrl: string | null = null;
      let mixInstrumentalUrl: string = publicAudioUrl;
      let fishConversionSucceeded = false;
      let rvcConversionSucceeded = false;

      const { isStemPipelineEnabled, pipelineModeLabel } = await import(
        "@/lib/pipeline-mode.server"
      );
      console.log(`[Pipeline] mode=${pipelineModeLabel()}`);

      if (isStemPipelineEnabled()) {
      // ── Gate 3: CWALO with Fallback Detour ───────────────────────────────
      if (!hasPassedGate(gateMask, PipelineGate.STORAGE)) {
        throw new Error("[Gate 3] Prerequisite failed: STORAGE bit not set.");
      }
      activeGate = 3;
      currentStep = "cwalo";
      telemetry = safeBumpTelemetry(telemetry, 3, "gate_3_analyzing");
      await beforeGate({ trackId, gate: 3, stage: "gate_3_analyzing" });
      reportPipelineProgress("cwalo", PIPELINE_PROGRESS.cwalo, undefined, gateMask);
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
        // Never surface Gate 1's AIMusicAPI breaker wording here.
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

      // ── Gate 5: RVC (pitch-preserving) → Fish → raw Demucs fallback ─────
      // Enforce Demucs bit before vocals.
      if (!hasPassedGate(gateMask, PipelineGate.DEMUX) || !canExecuteVocals(gateMask)) {
        throw new Error(
          "[Gate 5] Prerequisite failed: DEMUX bit not set before vocals.",
        );
      }
      activeGate = 5;
      currentStep = "vocals";
      telemetry = safeBumpTelemetry(telemetry, 5, "gate_5_converting");
      await beforeGate({ trackId, gate: 5, stage: "gate_5_converting" });
      reportPipelineProgress("vocals", PIPELINE_PROGRESS.vocals, undefined, gateMask);

      mixInstrumentalUrl = instrumentalStemUrl ?? publicAudioUrl;

      if (wantsVocals) {
        // Gate 5 pre-flight: valid Gate 4 vocal URL/buffer required before conversion.
        if (!vocalStemUrl || !isPublicHttpAudioUrl(vocalStemUrl)) {
          throw new Error(
            "[Gate 4] Stem Separation Failed: no isolated vocal stem available for voice conversion.",
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
          // Soft remux path: original Gate 2 master mix instead of null into conversion.
          console.warn(
            "[Gate 5] Empty Demucs vocal buffer — using Gate 2 master mix as vocal fallback for remux.",
          );
          mixVocalUrl = publicAudioUrl;
        } else {
          mixVocalUrl = vocalStemUrl;

          const { resolveRvcModelDownloadUrl, convertVocalsWithRvc } = await import(
            "@/lib/replicate-rvc.server"
          );
          const rvcModelZipUrl = resolveRvcModelDownloadUrl(input.rvcModelUrl);

          if (rvcModelZipUrl) {
            try {
              console.log("[Gate 5] RVC voice conversion (melodic pitch preserve)...");
              const finishedVocalStemUrl = await withTimeout(
                convertVocalsWithRvc({
                  guideVocalAudioUrl: vocalStemUrl,
                  customRvcModelDownloadUrl: rvcModelZipUrl,
                }),
                GATE_TIMEOUTS_MS[5],
                "Gate 5 (RVC)",
              );
              if (!finishedVocalStemUrl) {
                throw new Error("[Gate 5] RVC returned an empty vocal conversion URL.");
              }
              mixVocalUrl = finishedVocalStemUrl;
              rvcConversionSucceeded = true;
              fishConversionSucceeded = true; // bill vocals gate
              try {
                residue.trackBuffer(await downloadBuffer(finishedVocalStemUrl));
              } catch {
                /* keep mixVocalUrl; buffer optional for remux */
              }
            } catch (err) {
              const detail = sanitizeInheritedGate1Message(
                err instanceof Error ? err.message : String(err ?? "unknown"),
              );
              console.warn(
                "[Gate 5] RVC conversion failed/timed out — trying Fish Audio fallback:",
                detail || errorMessage(err),
              );
            }
          } else {
            console.log(
              "[Gate 5] No RVC model URL (rvcModelUrl / RVC_MODEL_DOWNLOAD_URL) — Fish Audio path",
            );
          }

          if (!rvcConversionSucceeded) {
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
                Math.min(GATE_TIMEOUTS_MS[5], 90_000),
                "Gate 5 (Fish Audio)",
              );
              const fishUrl = converted.tracks.find((t) => t.audioUrl)?.audioUrl ?? null;
              if (!fishUrl) {
                throw new Error("[Gate 5] Fish Audio returned an empty vocal conversion buffer.");
              }
              mixVocalUrl = fishUrl;
              fishConversionSucceeded = true;
              try {
                residue.trackBuffer(await downloadBuffer(fishUrl));
              } catch {
                /* keep mixVocalUrl */
              }
            } catch (err) {
              const detail = sanitizeInheritedGate1Message(
                err instanceof Error ? err.message : String(err ?? "unknown"),
              );
              console.warn(
                "[Gate 5] Fish Audio conversion failed/timed out, falling back to raw vocal stem:",
                detail || errorMessage(err),
              );
              mixVocalUrl = vocalStemUrl;
              fallbacksUsed.push(FALLBACK_FISH_AUDIO_RAW_VOCALS);
              telemetry = safeRecordFallback(telemetry, FALLBACK_FISH_AUDIO_RAW_VOCALS);
            }
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
              : rvcConversionSucceeded
                ? "RVC vocals ready"
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
      } else {
        // ── Production short path: Gate 2 CDN → Gate 6 (skip 3–5) ─────────
        console.log(
          "[Pipeline] Bypassing Gates 3–5 — Gate 6 masters Gate 2 Supabase vault audio directly. " +
            "Set HYBRID_ENABLE_STEM_PIPELINE=1 to restore CWALO/Demucs/RVC.",
        );
        const defaults = await applyDefaultCwaloStructure(trackId, input.durationSeconds);
        cwaloOutput = defaults.gate3;
        masterPlan = defaults.masterPlan;
        remuxGains = defaults.remuxGains;
        mixInstrumentalUrl = publicAudioUrl;
        mixVocalUrl = null;

        const bypassGates: Array<{
          gate: 3 | 4 | 5;
          flag: number;
          stage: "gate_3_analyzing" | "gate_4_splitting" | "gate_5_converting";
          progress: "cwalo" | "stems" | "vocals";
          step: string;
        }> = [
          {
            gate: 3,
            flag: PipelineGate.STRUCTURE,
            stage: "gate_3_analyzing",
            progress: "cwalo",
            step: "cwalo",
          },
          {
            gate: 4,
            flag: PipelineGate.DEMUX,
            stage: "gate_4_splitting",
            progress: "stems",
            step: "demux",
          },
          {
            gate: 5,
            flag: PipelineGate.VOCALS,
            stage: "gate_5_converting",
            progress: "vocals",
            step: "vocals",
          },
        ];
        for (const bypass of bypassGates) {
          activeGate = bypass.gate;
          currentStep = bypass.step;
          telemetry = safeBumpTelemetry(telemetry, bypass.gate, bypass.stage);
          await beforeGate({ trackId, gate: bypass.gate, stage: bypass.stage });
          reportPipelineProgress(
            bypass.progress,
            PIPELINE_PROGRESS[bypass.progress],
            undefined,
            gateMask,
          );
          gateMask = passGate(gateMask, bypass.flag);
          emitGateProgress(bypass.flag);
          await afterGate(
            { trackId, gate: bypass.gate, stage: bypass.stage },
            "bypassed → Gate 6 (Gate 2 vault audio)",
          );
        }
        console.log(
          `[Pipeline] Short path ready — Gate 6 input=${publicAudioUrl.slice(0, 96)}`,
        );
      }

      // ── Gate 6: FFmpeg Mastering & Final Vault Upload ────────────────────
      if (!hasPassedGate(gateMask, PipelineGate.VOCALS)) {
        throw new Error("[Gate 6] Prerequisite failed: VOCALS bit not set.");
      }
      if (!masterPlan || !cwaloOutput) {
        const defaults = await applyDefaultCwaloStructure(trackId, input.durationSeconds);
        cwaloOutput = defaults.gate3;
        masterPlan = defaults.masterPlan;
        remuxGains = defaults.remuxGains;
      }
      activeGate = 6;
      currentStep = "master";
      telemetry = safeBumpTelemetry(telemetry, 6, "gate_6_mastering");
      await beforeGate({ trackId, gate: 6, stage: "gate_6_mastering" });
      reportPipelineProgress("master", PIPELINE_PROGRESS.master, undefined, gateMask);
      const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
      let mastered: Awaited<ReturnType<typeof mixAndMasterHybridTrack>>;
      try {
        console.log("[Gate 6] Entering local FFmpeg master (EQ + two-pass loudnorm)", {
          source: isStemPipelineEnabled() ? "stems-remux→ffmpeg" : "gate2-vault→ffmpeg",
          instrumentalUrl: Boolean(mixInstrumentalUrl),
          vocalUrl: Boolean(mixVocalUrl),
          gate2Cdn: publicAudioUrl.slice(0, 64),
          ffmpegPath: process.env.FFMPEG_PATH || process.env.FFMPEG_BINARY || "(PATH)",
          gateTimeoutMs: GATE_TIMEOUTS_MS[6],
          replicate: false,
          matchering: false,
          resembleEnhance: false,
        });
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
        const detail = errorMessage(err);
        console.error("[Gate 6 Error] Mastering try/catch caught:", detail);
        if (err instanceof Error && err.stack) {
          console.error("[Gate 6 Error] stack:", err.stack.slice(0, 2500));
        }
        if (err instanceof Error && err.cause) {
          console.error(
            "[Gate 6 Error] cause:",
            err.cause instanceof Error ? err.cause.message : err.cause,
          );
        }
        throw new Error(`[Gate 6 Error] FFmpeg remux / mastering failed: ${detail}`, {
          cause: err instanceof Error ? err : undefined,
        });
      }

      if (!mastered.masterUrl || !mastered.mixed) {
        const reason =
          mastered.failureReason ||
          `mixed=${mastered.mixed}, masterUrl=${mastered.masterUrl ? "set" : "null"}`;
        console.error("[Gate 6 Error] Mastering returned no playable master:", reason, {
          mixed: mastered.mixed,
          matched: mastered.matched,
          masterUrlPresent: Boolean(mastered.masterUrl),
        });
        throw new Error(
          `[Gate 6 Error] Mastering did not produce a playable master. ${reason}`,
        );
      }

      let finalMasterUrl = mastered.masterUrl;
      try {
        const masterBuffer = await downloadBuffer(mastered.masterUrl);
        residue.trackBuffer(masterBuffer);
        const masterPath = `masters/${trackId.replace(/[^a-zA-Z0-9_-]/g, "_")}_master.wav`;
        const masterBucket = resolveAudioVaultBucket() || AUDIO_VAULT_BUCKET;
        await ensureAudioVaultBucket(supabaseAdmin, masterBucket);
        await withTimeout(
          (async () => {
            try {
              const { error } = await supabaseAdmin.storage.from(masterBucket).upload(
                masterPath,
                masterBuffer,
                { contentType: "audio/wav", upsert: true, cacheControl: "31536000" },
              );
              if (error) {
                console.error(
                  `[Gate 6 Error] Supabase master vault upload failed (bucket=${masterBucket}):`,
                  error.message,
                  error,
                );
                throw new Error(error.message);
              }
            } catch (uploadErr) {
              console.error("[Gate 6 Error] Unexpected master vault upload failure:", uploadErr);
              throw uploadErr instanceof Error
                ? uploadErr
                : new Error(String(uploadErr));
            }
          })(),
          30_000,
          "Gate 6 (Supabase Master Upload)",
        );
        const {
          data: { publicUrl },
        } = supabaseAdmin.storage.from(masterBucket).getPublicUrl(masterPath);
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
      // Token burn is idempotent with authorize-at-queue (alreadyApplied).
      const { generationTokenIdempotencyKey } = await import("@/lib/generation-tokens.server");
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
        idempotencyKey:
          input.tokenIdempotencyKey ?? generationTokenIdempotencyKey(trackId),
        tokenAmount: 1,
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
      await runSafeHook("prisma patch fail", async () => {
        const { patchPipelineTrack } = await import("@/lib/prisma.server");
        await patchPipelineTrack(trackId, {
          status: "FAILED",
          gateMask,
          errorMessage: message.slice(0, 2000),
        });
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
