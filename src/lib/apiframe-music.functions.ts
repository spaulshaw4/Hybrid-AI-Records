import { createServerFn } from "@tanstack/react-start";
import { limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  MIN_BPM,
  MAX_BPM,
  MIN_INFLUENCE,
  MAX_INFLUENCE,
  MIN_WEIRDNESS,
  MAX_WEIRDNESS,
  MIN_STYLE_INFLUENCE,
  MAX_STYLE_INFLUENCE,
} from "@/lib/engine-controls";
import { lyricLanguageFieldSchema } from "@/lib/lyric-languages";
import { DEFAULT_LONGFORM_SECONDS, MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";

export interface MusicGenerationRequest {
  genre: string;
  subGenre?: string;
  mood?: string;
  bpm?: number | string;
  instruments?: string[];
  vocalGender?: "Male" | "Female" | "Duet" | string;
  vocalTimbre?: string;
  vocalStyle?: string;
  lyrics: string;
  voiceId?: string;
  referenceAudioUrl?: string;
  isInstrumental?: boolean;
}

export function buildMiniMaxPayload(request: MusicGenerationRequest) {
  // 1. Build a strict, comma-separated style prompt (Target: 10 - 300 chars)
  const promptParts = [
    request.genre,
    request.subGenre,
    request.bpm ? `${request.bpm} BPM` : null,
    request.mood,
    request.instruments && request.instruments.length > 0 ? request.instruments.join(", ") : null,
    request.vocalGender ? `${request.vocalGender} vocal` : "Male vocal",
    request.vocalStyle,
    request.vocalTimbre,
    "studio recording",
  ].filter(Boolean);
  const stylePrompt = promptParts.join(", ");
  // 2. Separate style metadata from lyrics
  const payload: Record<string, any> = {
    model: "music-2.6",
    prompt: stylePrompt,
    lyrics: request.lyrics || "",
    is_instrumental: Boolean(request.isInstrumental),
    sample_rate: 44100,
    bitrate: 256000,
    audio_format: "mp3",
  };
  // 3. Attach custom voice cloning / reference if provided
  if (request.referenceAudioUrl || request.voiceId) {
    payload.audio_url = request.referenceAudioUrl || request.voiceId;
  }
  // 4. Log the exact outgoing payload
  console.log("[MINIMAX_STYLE_PROMPT]", stylePrompt);
  console.log("[MINIMAX_DISPATCH_PAYLOAD]", JSON.stringify(payload, null, 2));
  return payload;
}

function vocalGenderFromProfile(profile: string): string | undefined {
  const value = profile.toLowerCase();
  if (/\bfemale\b/.test(value) && /\bmale\b/.test(value)) return "Duet";
  if (/\bfemale\b/.test(value)) return "Female";
  if (/\bduet\b/.test(value)) return "Duet";
  if (/\bmale\b/.test(value)) return "Male";
  return undefined;
}

function vocalStyleFromProfile(profile: string): string | undefined {
  const withoutGender = profile
    .split(",")
    .map((part) => part.trim())
    .filter((part) => !/^(male|female) vocal$/i.test(part))
    .join(", ");
  return withoutGender || undefined;
}

export const SUNO_MODELS = ["V3_5", "V4", "V4_5"] as const;

/**
 * Advanced controls arrive as discrete numbers and are bounds-checked here.
 * The prompt directives are composed server-side so the browser can never
 * inject arbitrary directive text through these fields.
 */
const controlsSchema = z.object({
  bpm: z.number().int().min(MIN_BPM).max(MAX_BPM),
  influence: z.number().int().min(MIN_INFLUENCE).max(MAX_INFLUENCE),
  weirdness: z.number().int().min(MIN_WEIRDNESS).max(MAX_WEIRDNESS),
  styleInfluence: z.number().int().min(MIN_STYLE_INFLUENCE).max(MAX_STYLE_INFLUENCE),
});

const generateSchema = z.object({
  prompt: z.string().trim().min(3).max(6000),
  title: z.string().trim().max(120).default(""),
  style: z.string().trim().max(6000).default(""),
  lyrics: z.string().trim().max(6000).default(""),
  // Full AI track (vocals) by default; true renders an instrumental backing track.
  instrumental: z.boolean().default(false),

  audioFormat: z.enum(["mp3", "wav"]).default("mp3"),
  /** Optional cloned voice from the artist's Voice Library. */
  voiceId: z.string().trim().max(200).optional(),
  /** Studio legal-disclaimer checkbox. Required when cloning a custom voice. */
  termsAccepted: z.boolean().default(false),
  /**
   * Target lyric language. Drives pronunciation, diacritic handling and accent
   * in the engine prompt. Defaults to English so the form is never empty.
   */
  language: lyricLanguageFieldSchema,
  customLanguage: z.string().trim().max(60).default(""),
  customMode: z.boolean().default(false),
  /**
   * Sonic custom-mode tags: genre chips plus the artist's freeform style
   * prompt, passed through verbatim. The ceiling is a transport guard only —
   * never trim or rewrite descriptors the artist typed.
   */
  tags: z.string().trim().max(6000).optional(),
  /** Sonic model version. Studio Step 2 locks to sonic-v5. */
  mv: z.string().trim().max(40).optional(),
  model: z.enum(SUNO_MODELS).default("V4_5"),
  /** Ignored. Kept so older clients that still send an engine id do not 400. */
  engine: z.enum(["minimax", "hybrid", "elevenlabs"]).optional(),
  /** Target length in seconds. Clamped to the master ceiling on the server. */
  durationSeconds: z.number().int().min(10).max(MINIMAX_MAX_SECONDS).optional(),
  /** Ignored. Kept for older clients. */
  allowReslice: z.boolean().optional(),
  controls: controlsSchema.optional(),
  /** Core style/genre tags from the studio — not rewritten to a stock genre. */
  genre: z.string().trim().max(6000).optional(),
  subGenre: z.string().trim().max(6000).optional(),
  mood: z.string().trim().max(400).optional(),
  instruments: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  /** Default-AI vocal character (Aggressive Rock Vocal, Female Vocal, …). */
  vocalProfile: z.string().trim().max(400).optional(),
  vocalGender: z.string().trim().max(40).optional(),
  vocalTimbre: z.string().trim().max(400).optional(),
  vocalStyle: z.string().trim().max(400).optional(),
  /** Direct sample URL when the client already resolved the cloned take. */
  referenceAudioUrl: z.string().trim().max(2000).optional(),
  /** Open `user_vault` row to flip from processing → completed. */
  vaultId: z.preprocess((value) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
      ? trimmed
      : undefined;
  }, z.string().uuid().optional()),
  /** Same key the studio uses to charge on Generate, so a retry cannot double-spend. */
  idempotencyKey: z.string().trim().max(120).optional(),
});

export type GenerateEngineTrackInput = z.infer<typeof generateSchema>;

export function parseGenerateEngineTrackInput(data: unknown): GenerateEngineTrackInput {
  const parsed = generateSchema.safeParse(data);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const path = issue?.path?.length ? issue.path.join(".") : "payload";
  throw new Error(`Track setup: ${path} ${issue?.message ?? "was out of range"}`);
}

const taskSchema = z.object({ taskId: z.string().trim().min(1).max(200) });

type GenerateAuthContext = {
  userId: string;
  supabase: import("@supabase/supabase-js").SupabaseClient<
    import("@/integrations/supabase/types").Database
  >;
};

/**
 * Core studio generate (Gates 1–6). Used by the TanStack server fn and the
 * SSE keep-alive route so long Replicate waits do not idle-close the socket.
 */
export async function runGenerateEngineTrack(
  data: GenerateEngineTrackInput,
  context: GenerateAuthContext,
): Promise<Record<string, unknown>> {
    const { generateStudioTrack, getMusicApiKey, waitForStudioTrack } = await import(
      "@/lib/music-generation"
    );
    getMusicApiKey();
    limitBy("generateEngineTrack", context.userId, RATE_LIMITS.generation, "track generations");
    const { DEV_TEST_VOICE_ID, isDevAuthBypass } = await import("@/lib/dev-auth");
    const allowTokenless =
      isDevAuthBypass() ||
      process.env.HYBRID_ALLOW_TOKENLESS_GENERATE === "1" ||
      process.env.HYBRID_ALLOW_TOKENLESS_GENERATE === "true";
    if (!allowTokenless) {
    // Entitlement gate. Tokens are charged only after a successful render, but
    // the render itself costs real money, so the server refuses to start one
    // for an account with no balance instead of trusting the browser's check.
    const { data: balanceRow } = await context.supabase
      .from("token_balances")
      .select("balance")
      .eq("user_id", context.userId)
      .maybeSingle();
    if ((balanceRow?.balance ?? 0) < 1) {
      throw new Error("You need at least 1 Hybrid Token to generate a track.");
    }
    }

    const { newCorrelationId } = await import("@/lib/apiframe.server");
    const { logApiPayload } = await import("@/lib/generation-style-prompt");
    const {
      controls,
      durationSeconds: requestedSeconds,
      engine: _engine,
      allowReslice: _allowReslice,
      ...rest
    } = data;
    const durationSeconds = Math.min(
      MINIMAX_MAX_SECONDS,
      Math.max(10, requestedSeconds ?? DEFAULT_LONGFORM_SECONDS),
    );
    const payload = rest;
    const genre = (payload.genre || payload.style || payload.prompt).trim();
    const bpm = controls?.bpm;
    const mood = payload.mood?.trim() || "";
    const instruments = (payload.instruments ?? []).map((item) => item.trim()).filter(Boolean);
    const vocalProfile = payload.vocalProfile?.trim() || "";
    const lyricContent = payload.instrumental ? "" : payload.lyrics;
    const correlationId = newCorrelationId("gen");

    let referenceSampleUrl = payload.referenceAudioUrl?.trim() || undefined;
    const voiceId = payload.voiceId?.trim() || undefined;
    if (voiceId && !payload.instrumental) {
      const { VOCAL_CONSENT_REQUIRED_MESSAGE } = await import("@/lib/vocal-consent");
      if (!payload.termsAccepted) {
        throw new Error(VOCAL_CONSENT_REQUIRED_MESSAGE);
      }
      const { isLocalVocalProfileId } = await import("@/lib/vocal-profile-store");
      const isDevTestVoice = voiceId === DEV_TEST_VOICE_ID && isDevAuthBypass();
      const isLocalVoice = isLocalVocalProfileId(voiceId);
      if (!referenceSampleUrl && !isDevTestVoice && !isLocalVoice) {
        const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
        const voiceDb = tryGetSupabaseAdmin() ?? context.supabase;
        const { data: profile, error: profileError } = await voiceDb
          .from("voice_profiles")
          .select("sample_url")
          .eq("user_id", context.userId)
          .eq("voice_id", voiceId)
          .maybeSingle();
        if (profileError) {
          console.warn("[voice_profiles] resolve failed", profileError.message, profileError.code);
        }
        referenceSampleUrl = profile?.sample_url ?? undefined;
      }
      if (!referenceSampleUrl && !isDevTestVoice && !isLocalVoice) {
        throw new Error("That saved voice could not be loaded. Record or upload it again.");
      }
    }

    const minimaxDispatch = buildMiniMaxPayload({
      genre,
      subGenre: payload.subGenre?.trim() || undefined,
      mood: mood || undefined,
      bpm,
      instruments,
      vocalGender: payload.instrumental
        ? undefined
        : payload.vocalGender?.trim() || vocalGenderFromProfile(vocalProfile),
      vocalTimbre: payload.instrumental ? undefined : payload.vocalTimbre?.trim() || undefined,
      vocalStyle: payload.instrumental
        ? undefined
        : payload.vocalStyle?.trim() || vocalStyleFromProfile(vocalProfile),
      lyrics: lyricContent,
      voiceId,
      referenceAudioUrl: referenceSampleUrl,
      isInstrumental: payload.instrumental,
    });
    const stylePrompt = String(minimaxDispatch.prompt ?? "");

    logApiPayload({
      stylePrompt,
      prompt: stylePrompt,
      lyrics: lyricContent,
      genre,
      bpm: bpm ?? null,
      mood: mood || null,
      instruments,
      vocalProfile: vocalProfile || null,
      voice_id: voiceId ?? null,
      reference_audio: referenceSampleUrl ?? null,
      audio_url: minimaxDispatch.audio_url ?? null,
      instrumental: payload.instrumental,
      language: payload.language,
      customLanguage: payload.customLanguage,
      audioFormat: payload.audioFormat,
      durationSeconds,
    });

    const { PIPELINE_PROGRESS, reportPipelineProgress } = await import("@/lib/pipeline-progress");
    reportPipelineProgress("lyrics", PIPELINE_PROGRESS.lyrics);

    const {
      buildGenerationIdempotencyKey,
      coalesceGenerationRun,
      reserveGenerationTokenIntent,
      clearGenerationTokenIntent,
    } = await import("@/lib/pipeline-idempotency.server");

    const idempotencyKey =
      payload.idempotencyKey?.trim() ||
      buildGenerationIdempotencyKey({
        userId: context.userId,
        prompt: lyricContent || genre,
        style: genre,
        lyrics: lyricContent,
        instrumental: payload.instrumental,
      });

    reserveGenerationTokenIntent(idempotencyKey);

    try {
    const { value: generateResult, coalesced } = await coalesceGenerationRun(
      idempotencyKey,
      context.userId,
      async () => {
    let started: Awaited<ReturnType<typeof generateStudioTrack>>;
    let finished: Awaited<ReturnType<typeof waitForStudioTrack>>;
    let startedTaskId: string | null = null;
    try {
    started = await generateStudioTrack({
      genre,
      subGenre: payload.subGenre?.trim() || undefined,
      mood: mood || undefined,
      bpm,
      instruments,
      vocalTimbre: payload.vocalTimbre?.trim() || undefined,
      styleInfluence: controls?.styleInfluence,
      audioInfluence: controls?.influence,
      weirdness: controls?.weirdness,
      vocalGender: payload.instrumental
        ? undefined
        : payload.vocalGender?.trim() || vocalGenderFromProfile(vocalProfile),
      lyrics: lyricContent,
      tags: payload.tags?.trim() || undefined,
      title: payload.title || "Studio Master",
      isInstrumental: payload.instrumental,
      mv: "sonic-v5",
    });
    startedTaskId = started.taskId;
    const { withTimeout, GATE_TIMEOUTS_MS } = await import("@/lib/pipeline-gate.server");
    const { reportPipelineProgress: reportGate1Progress, PIPELINE_PROGRESS: gate1Progress } =
      await import("@/lib/pipeline-progress");
    reportGate1Progress("composition", gate1Progress.sonic);
    console.log("[Gate 1/6] currentStep=composition — Base Generation poll…");
    try {
      finished = await withTimeout(
        waitForStudioTrack(started.taskId),
        GATE_TIMEOUTS_MS[1],
        "Gate 1 (AIMusicAPI)",
        { step: "composition" },
      );
    } catch (err) {
      if (err && typeof err === "object" && "step" in err) throw err;
      const e = new Error(
        err instanceof Error ? err.message : String(err ?? "Gate 1 timed out"),
      ) as Error & { step: string };
      e.step = "composition";
      throw e;
    }
    const sonicUrl = finished.audioUrl;
    if (!sonicUrl) {
      const empty = new Error(
        "[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.",
      ) as Error & { step: string };
      empty.step = "composition";
      throw empty;
    }
    console.log("[Gate 1/6] Finished — audio_url ready");

    const { executePipeline } = await import("@/lib/execute-pipeline.server");
    const { runHeavyPipelineJob } = await import("@/lib/pipeline-worker.server");
    const pipeline = await runHeavyPipelineJob({
      trackId: started.taskId,
      userId: context.userId,
      work: () =>
        executePipeline({
          trackId: started.taskId,
          prompt: lyricContent || genre,
          style: genre,
          userId: context.userId,
          gate1AudioUrl: sonicUrl,
          lyrics: lyricContent,
          instrumental: payload.instrumental,
          referenceSampleUrl,
          audioFormat: payload.audioFormat,
          title: payload.title || "Studio Master",
          durationSeconds,
          language: payload.language,
          customLanguage: payload.customLanguage,
        }),
    });

    const rawTracks = [
      {
        id: started.taskId,
        title: finished.title || payload.title || "Mastered track",
        audioUrl: pipeline.publicAudioUrl,
        imageUrl: finished.imageUrl,
        duration: durationSeconds,
      },
    ];
    const tracks = rawTracks;

    const vocalUrl = pipeline.vocalUrl;
    const instrumentalUrl = pipeline.instrumentalUrl;
    const introUrl = null;
    const rawAudioUrl = pipeline.publicAudioUrl;
    let masterUrl = pipeline.masterUrl;
    const taskId = started.taskId;

    if (!masterUrl || !pipeline.mixed) {
      throw new Error("Mastering did not finish. Try generating again.");
    }

    if (payload.vaultId && masterUrl) {
      try {
        const { uploadMasterToVaultFromUrl } = await import("@/lib/audio-vault-upload.server");
        masterUrl = await uploadMasterToVaultFromUrl(masterUrl, payload.vaultId, "mp3");
      } catch (error) {
        console.warn(
          "[audio-vault] master upload failed",
          error instanceof Error ? error.message : error,
        );
      }
    }

    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = tryGetSupabaseAdmin() ?? context.supabase;

    const { persistHybridTrack } = await import("@/lib/hybrid-tracks.server");
    await persistHybridTrack(db, context.userId, {
      title: payload.title || "Untitled master track",
      genrePrompt: genre,
      lyrics: payload.instrumental ? "" : payload.lyrics,
      introUrl,
      instrumentalUrl,
      vocalUrl,
      masterUrl,
    });

    const { persistUserVault } = await import("@/lib/user-vault.server");
    const vaultId = await persistUserVault(db, context.userId, {
      id: payload.vaultId,
      title: payload.title || "Untitled Track",
      style: genre,
      status: "completed",
      masterUrl,
      instrumentalUrl,
      vocalUrl,
      rawAudioUrl,
    });
    if (masterUrl) {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({
        taskId: payload.vaultId ?? vaultId ?? taskId,
        userId: context.userId,
        audioUrl: masterUrl,
      });
    }
    if (!vaultId && masterUrl) {
      const { persistLocalVaultTrack } = await import("@/lib/local-vault.server");
      await persistLocalVaultTrack(context.userId, {
        id: payload.vaultId,
        title: payload.title || "Untitled Track",
        style: genre,
        status: "completed",
        masterUrl,
        instrumentalUrl,
        vocalUrl,
        rawAudioUrl,
      });
    }

    const playableTracks = [
          {
            id: `${taskId}-master`,
            title: payload.title || "Mastered track",
            audioUrl: masterUrl,
            imageUrl: null,
            duration: durationSeconds,
          },
        ];

    return {
      taskId,
      status: pipeline.status === "completed_fallback" ? ("completed" as const) : ("completed" as const),
      tracks: playableTracks,
      stems: {
        masterUrl,
        instrumentalUrl,
        vocalUrl,
        introUrl,
        rawAudioUrl,
      },
      correlationId,
      cached: false,
      engine: "suno" as const,
      requestedEngine: "suno" as const,
      durationSeconds,
      routingNote: null,
      landing: {
        status: pipeline.status,
        trackId: taskId,
        masterUrl,
        duration: pipeline.duration,
        structuralMarkers: pipeline.structuralMarkers,
        fallbacksUsed: pipeline.fallbacksUsed,
        executionTimeMs: pipeline.executionTimeMs,
        pipelineState: pipeline.pipelineState,
      },
      gateMask: pipeline.pipelineState,
      tokenSettled: Boolean(pipeline.tokenSettled),
      settlement: pipeline.settlement ?? null,
      chargeLedger: pipeline.chargeLedger ?? pipeline.settlement?.chargeLedger ?? [],
      totalCharged: pipeline.totalCharged ?? pipeline.settlement?.totalCharged ?? 0,
    };
    } catch (error) {
      const { TrackLockConflictError } = await import("@/lib/track-lock.server");
      const { WorkerSlotBusyError } = await import("@/lib/pipeline-worker.server");
      const { isPipelineAbortError } = await import("@/lib/execute-pipeline.server");
      if (error instanceof TrackLockConflictError || error instanceof WorkerSlotBusyError) {
        throw error;
      }
      const { logFailedStudioGate } = await import("@/lib/studio-pipeline-error");
      logFailedStudioGate(error);
      // A halted render must not leave the task row claiming it is still
      // processing, or the vault badge spins forever.
      const { failGenerationTask } = await import("@/lib/engine-pipeline.server");
      const abortLanding = isPipelineAbortError(error) ? error.landing : null;
      await failGenerationTask({
        taskId: startedTaskId,
        userId: context.userId,
        reason: abortLanding?.error ?? (error instanceof Error ? error.message : String(error ?? "")),
      }).catch(() => undefined);
      if (abortLanding) {
        const abortError = new Error(abortLanding.error) as Error & {
          landing: typeof abortLanding;
          statusCode: number;
        };
        abortError.name = "PipelineAbortError";
        abortError.landing = abortLanding;
        abortError.statusCode = 500;
        throw abortError;
      }
      throw error;
    }
      },
    );

    clearGenerationTokenIntent(idempotencyKey);
    if (coalesced) {
      console.log(
        `[Idempotency] Returned coalesced generate result key=${idempotencyKey.slice(0, 12)}…`,
      );
    }
    return generateResult;
  } catch (outerError) {
    clearGenerationTokenIntent(idempotencyKey);
    throw outerError;
  }
}

/**
 * Studio generate — TanStack Start server function (Node `process.env`).
 * Prefer `/api/studio/generate-stream` from the browser so keepalives prevent
 * idle "Failed to fetch" drops during long Replicate waits.
 */
export const generateEngineTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => parseGenerateEngineTrackInput(data))
  .handler(async ({ data, context }) => runGenerateEngineTrack(data, context));



export const getEngineTrackTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => taskSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { fetchStudioTrackTask } = await import("@/lib/music-generation");
    const { archiveGeneratedAudio, fetchApiframeTask, newCorrelationId } = await import("@/lib/apiframe.server");
    const correlationId = newCorrelationId("poll");
    try {
      const sonic = await fetchStudioTrackTask(data.taskId);
      const audioUrl = sonic.audioUrl
        ? await archiveGeneratedAudio(sonic.audioUrl, context.userId, data.taskId).catch(() => sonic.audioUrl)
        : null;
      return {
        taskId: sonic.taskId,
        status: sonic.status === "completed" ? "succeeded" : sonic.status,
        tracks: audioUrl
          ? [{ id: sonic.taskId, title: sonic.title || "Mastered track", audioUrl, imageUrl: sonic.imageUrl, duration: null }]
          : [],
        correlationId,
      };
    } catch {
      const result = await fetchApiframeTask(data.taskId, correlationId);
      const tracks = await Promise.all(
        result.tracks.map(async (track) => ({
          ...track,
          audioUrl: track.audioUrl
            ? await archiveGeneratedAudio(track.audioUrl, context.userId, data.taskId).catch(() => null)
            : null,
        })),
      );

      return {
        taskId: result.taskId ?? data.taskId,
        status: result.status,
        tracks,
        correlationId,
      };
    }
  });

/** Preflight check so the studio can warn before anyone starts a generation. */
export const checkEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { checkApiframeHealth, newCorrelationId } = await import("@/lib/apiframe.server");
    const correlationId = newCorrelationId("health");
    return { ...(await checkApiframeHealth(correlationId)), correlationId };
  });
