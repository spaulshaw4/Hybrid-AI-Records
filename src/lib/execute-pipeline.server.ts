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
  bumpTelemetry,
  recordFallback,
  type Gate3Result,
  type LandingSuccessResponse,
  type MusicSectionMarker,
  type PipelineResponse,
} from "@/types/pipeline";

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

async function cleanupTempFiles(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((p) => cleanupAudioWriteResidue(p)));
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("Downloaded audio was empty.");
  return bytes;
}

function markersFromGate3(gate3: Gate3Result): MusicSectionMarker[] {
  return gate3.markers;
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

  try {
    const supabase = createEngineSupabaseClient();
    if (!supabase) {
      throw new Error("[Gate 2 Error] Missing Supabase admin client for vault upload.");
    }

    // ── Gate 1: Base Generation (AIMusicAPI) ───────────────────────────────
    console.log(`[Gate 1/6] Base generation starting for track ${trackId}...`);
    telemetry = bumpTelemetry(telemetry, 1, "gate_1_generating");

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

    // ── Gate 2: Supabase Storage & Public CDN Link ─────────────────────────
    console.log(`[Gate 2/6] Uploading raw audio to Supabase vault...`);
    telemetry = bumpTelemetry(telemetry, 2, "gate_2_vaulting");
    const rawPath = `raw/${trackId.replace(/[^a-zA-Z0-9_-]/g, "_")}.mp3`;
    await withTimeout(
      (async () => {
        const { error } = await supabase.storage.from(AUDIO_VAULT_BUCKET).upload(
          rawPath,
          rawAudioBuffer,
          { contentType: "audio/mpeg", upsert: true },
        );
        if (error) throw new Error(error.message);
      })(),
      GATE_TIMEOUTS_MS[2],
      "Gate 2 (Supabase Upload)",
    );
    const {
      data: { publicUrl: publicAudioUrl },
    } = supabase.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(rawPath);
    if (!publicAudioUrl || !publicAudioUrl.startsWith("http") || !isPublicHttpAudioUrl(publicAudioUrl)) {
      throw new Error("[Gate 2 Error] Failed to generate a public HTTPS CDN URL.");
    }

    // ── Gate 3: CWALO with Fallback Detour ─────────────────────────────────
    console.log(`[Gate 3/6] Running CWALO structural analysis...`);
    telemetry = bumpTelemetry(telemetry, 3, "gate_3_analyzing");
    let gate3: Gate3Result;
    let masterPlan: import("@/lib/cwalo-structure.server").CwaloMasterPlan | null = null;
    let remuxGains = { instrumentalVolume: 1.0, vocalVolume: 1.0 };
    try {
      const { analyzeMusicStructureWithCwalo, buildCwaloMasterPlan } = await import(
        "@/lib/cwalo-structure.server"
      );
      const structure = await withTimeout(
        analyzeMusicStructureWithCwalo(publicAudioUrl),
        GATE_TIMEOUTS_MS[3],
        "Gate 3 (CWALO)",
      );
      remuxGains = structure.remux;
      masterPlan = structure.masterPlan;
      gate3 = {
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
      console.warn("[Gate 3 Fallback] CWALO bypassed. Using default structural markers.", err);
      gate3 = generateDefaultStructure(input.durationSeconds ?? 180, trackId);
      fallbacksUsed.push(FALLBACK_CWALO_DEFAULT_STRUCTURE);
      telemetry = recordFallback(telemetry, FALLBACK_CWALO_DEFAULT_STRUCTURE);
      const { buildCwaloMasterPlan } = await import("@/lib/cwalo-structure.server");
      masterPlan = buildCwaloMasterPlan({
        sections: gate3.markers.map((m) => ({ start: m.start, end: m.end, label: m.label })),
        bpm: gate3.bpm ?? null,
        beats: [],
        downbeats: [],
        energyProfile: gate3.markers.map((m) => m.energyLevel ?? 0.7),
        durationSeconds: gate3.markers.at(-1)?.end ?? null,
        outroStart: gate3.markers.find((m) => m.label === "outro")?.start ?? null,
        trackEnd: gate3.markers.at(-1)?.end ?? null,
      });
      remuxGains = masterPlan.remux;
    }

    // ── Gate 4: Demucs ─────────────────────────────────────────────────────
    console.log(`[Gate 4/6] Demucs stem separation starting...`);
    telemetry = bumpTelemetry(telemetry, 4, "gate_4_splitting");
    const { separateStemsFromPublicUrl } = await import("@/lib/stems.server");
    const demucsOutput = await withTimeout(
      separateStemsFromPublicUrl(publicAudioUrl),
      GATE_TIMEOUTS_MS[4],
      "Gate 4 (Demucs)",
    );
    const vocalStemUrl = demucsOutput.vocals;
    const backingStemUrlValue = backingStemUrl(demucsOutput);
    if (wantsVocals && (!vocalStemUrl || !backingStemUrlValue)) {
      throw new Error("[Circuit Breaker] Gate 4 failed: Missing split stems in Demucs payload.");
    }

    // ── Gate 5: Fish Audio with Fallback Detour ────────────────────────────
    console.log(`[Gate 5/6] Fish Audio vocal conversion starting...`);
    telemetry = bumpTelemetry(telemetry, 5, "gate_5_converting");
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
        if (!mixVocalUrl) throw new Error("Empty vocal conversion buffer.");
      } catch (err) {
        console.warn(
          "[Gate 5 Fallback] Fish Audio bypassed. Using raw Demucs vocal stem.",
          err,
        );
        const fallbackResult = await fetchRawVocalFallback(vocalStemUrl, trackId);
        convertedVocalBuffer = fallbackResult.convertedVocalBuffer;
        residue.trackBuffer(convertedVocalBuffer);
        mixVocalUrl = vocalStemUrl;
        fallbacksUsed.push(FALLBACK_FISH_AUDIO_RAW_VOCALS);
        telemetry = recordFallback(telemetry, FALLBACK_FISH_AUDIO_RAW_VOCALS);
      }
    }

    const mixInstrumentalUrl =
      backingStemUrlValue ?? (wantsVocals ? null : publicAudioUrl);
    if (wantsVocals && (!mixVocalUrl || !mixInstrumentalUrl)) {
      throw new Error("[Gate 5 Error] Missing vocal or backing stem for remux.");
    }

    // ── Gate 6: FFmpeg Mastering & Final Vault Upload ──────────────────────
    console.log(`[Gate 6/6] Executing FFmpeg master and final vault sync...`);
    telemetry = bumpTelemetry(telemetry, 6, "gate_6_mastering");
    const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
    const mastered = await withTimeout(
      mixAndMasterHybridTrack({
        introUrl: null,
        instrumentalUrl: mixInstrumentalUrl,
        vocalUrl: mixVocalUrl,
        userId: input.userId,
        taskId: trackId,
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
      "Gate 6 (FFmpeg Remux)",
    );

    if (!mastered.masterUrl || !mastered.mixed) {
      throw new Error("[Gate 6 Error] Mastering did not produce a playable master.");
    }

    // Prefer vaulting an explicit WAV master when we can fetch bytes; else keep CDN URL.
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
        err instanceof Error ? err.message : err,
      );
    }

    console.log(`[Pipeline Success] Master ready at: ${finalMasterUrl}`);
    telemetry = bumpTelemetry(
      telemetry,
      6,
      fallbacksUsed.length ? "landing_fallback" : "landing_success",
    );

    const landing: ExecutePipelineSuccess = {
      status: fallbacksUsed.length ? "completed_fallback" : "success",
      trackId,
      masterUrl: finalMasterUrl,
      duration: input.durationSeconds ?? gate3.markers.at(-1)?.end ?? 0,
      structuralMarkers: markersFromGate3(gate3),
      fallbacksUsed,
      executionTimeMs: Date.now() - startedAt,
      vocalUrl: mixVocalUrl,
      instrumentalUrl: mixInstrumentalUrl,
      publicAudioUrl,
      mixed: mastered.mixed,
      matched: mastered.matched,
    };
    void convertedVocalBuffer;
    void telemetry;
    return landing;
  } finally {
    // Landing Rule 4: Always release lock and cleanup
    releaseTrackLock(trackId);
    await residue.dispose().catch(() => undefined);
    await cleanupTempFiles(...tmpFiles);
  }
}

export type { PipelineResponse };
