import { createServerFn } from "@tanstack/react-start";
import { limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_LONGFORM_SECONDS, MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";
import { parseGenerateEngineTrackInput, type GenerateEngineTrackInput } from "@/lib/generate-schema";

export {
  generateSchema,
  parseGenerateEngineTrackInput,
  SUNO_MODELS,
  type GenerateEngineTrackInput,
} from "@/lib/generate-schema";

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
    console.log("[WORKER_PAYLOAD] studio generate", {
      genreChars: genre.length,
      promptChars: (payload.prompt || "").length,
      styleChars: (payload.style || "").length,
      lyricsChars: (payload.lyrics || "").length,
      instrumental: Boolean(payload.instrumental),
      title: payload.title || "",
      vaultId: payload.vaultId ?? null,
    });
    if (!genre) {
      const empty = new Error(
        "[Circuit Breaker] Gate 1 failed: API payload dropped genre/style/prompt — nothing to generate.",
      ) as Error & { step: string };
      empty.step = "composition";
      throw empty;
    }
    const bpm = controls?.bpm;
    const mood = payload.mood?.trim() || "";
    const instruments = (payload.instruments ?? []).map((item) => item.trim()).filter(Boolean);
    const vocalProfile = payload.vocalProfile?.trim() || "";
    const lyricContent = payload.instrumental ? "" : payload.lyrics;
    const correlationId = newCorrelationId("gen");

    let referenceSampleUrl = payload.referenceAudioUrl?.trim() || undefined;
    const rvcModelUrl = payload.rvcModelUrl?.trim() || undefined;
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
    const {
      authorizeAndSpendGenerationToken,
      generationTokenIdempotencyKey,
      refundGenerationToken,
    } = await import("@/lib/generation-tokens.server");

    const idempotencyKey =
      payload.idempotencyKey?.trim() ||
      buildGenerationIdempotencyKey({
        userId: context.userId,
        prompt: lyricContent || genre,
        style: genre,
        lyrics: lyricContent,
        instrumental: payload.instrumental,
      });

    const spendKey = generationTokenIdempotencyKey(idempotencyKey);

    // Universal atomic burn — before any AI vendor call. Disconnect / refresh
    // after this point does not reverse the ledger row (failures refund below).
    const tokenAuth = await authorizeAndSpendGenerationToken({
      userId: context.userId,
      supabase: context.supabase,
      idempotencyKey: spendKey,
      amount: 1,
      note: payload.title || "Studio master generation",
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
    const { hybridWorkerUrl, generateFromHybridWorker, LOCAL_WORKER_TIMEOUT_MS } =
      await import("@/lib/hybrid-worker.server");
    const workerUrl = hybridWorkerUrl();
    if (workerUrl) {
      const { withTimeout: workerTimeout } = await import("@/lib/pipeline-gate.server");
      const local = await workerTimeout(
        generateFromHybridWorker({
          prompt: payload.prompt || genre,
          genreHint: genre,
          durationSeconds,
          bpm,
          instrumental: payload.instrumental,
          lyrics: lyricContent,
        }),
        LOCAL_WORKER_TIMEOUT_MS,
        "Gate 1 (local Hybrid worker)",
        { step: "composition" },
      );
      started = {
        taskId: local.sessionId,
        payload: {} as Awaited<ReturnType<typeof generateStudioTrack>>["payload"],
        status: "processing",
      };
      finished = {
        taskId: local.sessionId,
        status: "completed",
        audioUrl: local.audioUrl,
        imageUrl: null,
        title: payload.title || null,
        duration: null,
        trackIds: [local.sessionId],
        rawStatus: "completed",
        clipCount: 1,
      };
      startedTaskId = local.sessionId;
    } else {
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
    console.log(
      `[Composition] Initial provider response: accepted & taskId=${started.taskId}`,
    );

    // Register pending vault + provider task id IMMEDIATELY so a mid-poll
    // client disconnect cannot orphan the job with no recoverable row.
    if (payload.vaultId) {
      try {
        const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { persistUserVault } = await import("@/lib/user-vault.server");
        const vaultDb = tryGetSupabaseAdmin() ?? context.supabase;
        await persistUserVault(vaultDb, context.userId, {
          id: payload.vaultId,
          title: payload.title || "Untitled Track",
          style: genre,
          status: "processing",
          providerTaskId: started.taskId,
        });
      } catch (error) {
        console.warn(
          "[Composition] Pending vault write skipped",
          error instanceof Error ? error.message : error,
        );
      }
    }
    try {
      const { emitGenerateSseEvent } = await import("@/lib/studio-generate-stream.server");
      emitGenerateSseEvent("task", {
        taskId: started.taskId,
        vaultId: payload.vaultId ?? null,
        status: "processing",
      });
    } catch {
      /* not under SSE — TanStack server-fn path */
    }

    const { withTimeout } = await import("@/lib/pipeline-gate.server");
    const { COMPOSITION_POLL_TIMEOUT_MS } = await import("@/lib/music-generation");
    const { reportPipelineProgress: reportGate1Progress, PIPELINE_PROGRESS: gate1Progress } =
      await import("@/lib/pipeline-progress");
    reportGate1Progress("composition", gate1Progress.sonic);
    console.log("[Gate 1/6] currentStep=composition — Base Generation poll…");
    try {
      finished = await withTimeout(
        waitForStudioTrack(started.taskId),
        COMPOSITION_POLL_TIMEOUT_MS,
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
    }
    const sonicUrl = finished.audioUrl;
    console.log("[HANDOFF] generation -> composition", {
      audioUrlChars: sonicUrl ? sonicUrl.length : 0,
      taskId: started.taskId,
    });
    if (!sonicUrl) {
      const empty = new Error(
        "[Circuit Breaker] Gate 1 failed: Empty audio buffer returned.",
      ) as Error & { step: string };
      empty.step = "composition";
      throw empty;
    }
    console.log("[Gate 1/6] Finished — audio_url ready");

    // Persist Gate 1 raw audio into user_vault immediately (service role) so a
    // mid-render client disconnect cannot orphan the job with no vault row.
    if (payload.vaultId && sonicUrl) {
      try {
        const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { persistUserVault } = await import("@/lib/user-vault.server");
        const vaultDb = tryGetSupabaseAdmin() ?? context.supabase;
        console.log("[Composition] Audio URL received -> Writing to user_vault");
        await persistUserVault(vaultDb, context.userId, {
          id: payload.vaultId,
          title: payload.title || "Untitled Track",
          style: genre,
          status: "processing",
          rawAudioUrl: sonicUrl,
          providerTaskId: started.taskId,
        });
      } catch (error) {
        console.warn(
          "[user_vault] Gate 1 raw persist skipped",
          error instanceof Error ? error.message : error,
        );
      }
    }

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
          rvcModelUrl,
          audioFormat: payload.audioFormat,
          title: payload.title || "Studio Master",
          durationSeconds,
          language: payload.language,
          customLanguage: payload.customLanguage,
          tokenIdempotencyKey: spendKey,
          vaultId: payload.vaultId,
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
    console.log("Writing track to vault:", payload.vaultId ?? taskId, {
      userId: context.userId,
    });
    let vaultId: string | null = null;
    try {
      // Always bind the row to HER session user.id — never an admin/static UUID.
      vaultId = await persistUserVault(db, context.userId, {
        id: payload.vaultId,
        title: payload.title || "Untitled Track",
        style: genre,
        status: "completed",
        masterUrl,
        instrumentalUrl,
        vocalUrl,
        rawAudioUrl,
        providerTaskId: taskId,
        tokensUsed: 1,
      });
    } catch (error) {
      console.error(
        "[Vault Save Error]: final persist threw for user:",
        context.userId,
        error instanceof Error ? error.message : error,
      );
      // Local-dev catalog only — real profiles must not lose tokens on a silent miss.
      const { DEV_TEST_USER_UUID } = await import("@/lib/dev-auth");
      if (masterUrl && context.userId === DEV_TEST_USER_UUID) {
        try {
          const { persistLocalVaultTrack } = await import("@/lib/local-vault.server");
          vaultId = await persistLocalVaultTrack(context.userId, {
            id: payload.vaultId,
            title: payload.title || "Untitled Track",
            style: genre,
            status: "completed",
            masterUrl,
            instrumentalUrl,
            vocalUrl,
            rawAudioUrl,
          });
        } catch {
          /* fall through to rethrow */
        }
      }
      if (!vaultId) {
        // Rethrow so outer catch refunds the burned Hybrid Token.
        throw error instanceof Error
          ? error
          : new Error(`Vault insert failed for user: ${context.userId}`);
      }
    }
    if (masterUrl) {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({
        taskId: payload.vaultId ?? vaultId ?? taskId,
        vaultId: payload.vaultId ?? vaultId,
        userId: context.userId,
        audioUrl: masterUrl,
        title: payload.title || "Untitled Track",
        style: genre,
        instrumentalUrl,
        vocalUrl,
        rawAudioUrl,
      });
    }
    if (!vaultId && masterUrl) {
      const { DEV_TEST_USER_UUID } = await import("@/lib/dev-auth");
      if (context.userId === DEV_TEST_USER_UUID) {
        const { persistLocalVaultTrack } = await import("@/lib/local-vault.server");
        vaultId = await persistLocalVaultTrack(context.userId, {
          id: payload.vaultId,
          title: payload.title || "Untitled Track",
          style: genre,
          status: "completed",
          masterUrl,
          instrumentalUrl,
          vocalUrl,
          rawAudioUrl,
        });
      } else {
        throw new Error(`Vault insert failed for user: ${context.userId}`);
      }
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
      /** Confirmed `user_vault.id` from service-role persist (SSE `result` event). */
      vaultId: vaultId ?? payload.vaultId ?? null,
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
      // Prefer the pre-pipeline burn; settlement uses the same idempotency key.
      tokenSettled: true,
      tokenBypassed: tokenAuth.bypassed,
      balance: tokenAuth.balance,
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
      const failReason =
        abortLanding?.error ?? (error instanceof Error ? error.message : String(error ?? ""));
      console.error("[Composition] Marking user_vault failed", {
        vaultId: payload.vaultId ?? null,
        taskId: startedTaskId,
        reason: failReason.slice(0, 200),
      });
      await failGenerationTask({
        taskId: startedTaskId,
        vaultId: payload.vaultId,
        userId: context.userId,
        reason: failReason,
      }).catch(() => undefined);
      // Belt-and-suspenders service-role vault flip when failGenerationTask skips.
      if (payload.vaultId) {
        try {
          const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { persistUserVault } = await import("@/lib/user-vault.server");
          const vaultDb = tryGetSupabaseAdmin() ?? context.supabase;
          await persistUserVault(vaultDb, context.userId, {
            id: payload.vaultId,
            title: payload.title || "Untitled Track",
            style: genre,
            status: "failed",
            providerTaskId: startedTaskId,
          });
        } catch {
          /* already logged upstream */
        }
      }
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
    // Upstream / pipeline failure after a successful burn → automatic refund.
    if (!tokenAuth.bypassed) {
      const reason =
        outerError instanceof Error ? outerError.message : String(outerError ?? "Generation failed");
      await refundGenerationToken({
        userId: context.userId,
        amount: 1,
        spendIdempotencyKey: spendKey,
        note: `Refund: ${reason.slice(0, 180)}`,
      }).catch((refundErr) => {
        console.error(
          "[generation-tokens] automatic refund threw",
          refundErr instanceof Error ? refundErr.message : refundErr,
        );
      });
      const { isTransientUpstreamError, markEngineBusyRefunded } = await import(
        "@/lib/engine-bounce-back"
      );
      if (isTransientUpstreamError(outerError)) {
        throw markEngineBusyRefunded(outerError);
      }
    }
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
  .validator((data: unknown) => parseGenerateEngineTrackInput(data))
  .handler(async ({ data, context }) => {
    // All server-fn generates enter the cortex (Gate 1–2); worker finishes Gate 3.
    const { executeGenerationCortex } = await import("@/lib/cortex-dispatcher.server");
    return executeGenerationCortex({
      userId: context.userId,
      supabase: context.supabase,
      promptPayload: data,
    });
  });



export type EngineTrackTaskPollResult = {
  taskId: string;
  status: string;
  tracks: Array<{
    id: string;
    title: string | null;
    audioUrl: string | null;
    imageUrl?: string | null;
    duration: number | null;
  }>;
  correlationId: string;
};

/**
 * Server-side MusicAPI / Apiframe poll. Used by the TanStack server fn and by
 * GET /api/generate/status so the browser never calls provider URLs directly.
 */
export async function pollEngineTrackTask(
  taskId: string,
  userId: string,
): Promise<EngineTrackTaskPollResult> {
  const { fetchStudioTrackTask } = await import("@/lib/music-generation");
  const { archiveGeneratedAudio, fetchApiframeTask, newCorrelationId } = await import(
    "@/lib/apiframe.server"
  );
  const correlationId = newCorrelationId("poll");
  try {
    const sonic = await fetchStudioTrackTask(taskId);
    const audioUrl = sonic.audioUrl
      ? await archiveGeneratedAudio(sonic.audioUrl, userId, taskId).catch(() => sonic.audioUrl)
      : null;
    return {
      taskId: sonic.taskId,
      status: sonic.status === "completed" ? "succeeded" : sonic.status,
      tracks: audioUrl
        ? [
            {
              id: sonic.taskId,
              title: sonic.title || "Mastered track",
              audioUrl,
              imageUrl: sonic.imageUrl,
              duration: null,
            },
          ]
        : [],
      correlationId,
    };
  } catch {
    const result = await fetchApiframeTask(taskId, correlationId);
    const tracks = await Promise.all(
      result.tracks.map(async (track) => ({
        ...track,
        audioUrl: track.audioUrl
          ? await archiveGeneratedAudio(track.audioUrl, userId, taskId).catch(() => null)
          : null,
      })),
    );

    return {
      taskId: result.taskId ?? taskId,
      status: result.status,
      tracks,
      correlationId,
    };
  }
}

export const getEngineTrackTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => taskSchema.parse(data))
  .handler(async ({ data, context }) => pollEngineTrackTask(data.taskId, context.userId));

/** Preflight check so the studio can warn before anyone starts a generation. */
export const checkEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { checkApiframeHealth, newCorrelationId } = await import("@/lib/apiframe.server");
    const correlationId = newCorrelationId("health");
    return { ...(await checkApiframeHealth(correlationId)), correlationId };
  });
