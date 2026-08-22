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
import { DEFAULT_LYRIC_LANGUAGE, lyricLanguageSchema } from "@/lib/lyric-languages";
import { DEFAULT_LONGFORM_SECONDS, MINIMAX_MAX_SECONDS } from "@/lib/engine-routing";


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
   * in the engine prompt — validated here so the browser can only pick a
   * supported option (or supply a short free-text label under "custom").
   */
  language: lyricLanguageSchema.default(DEFAULT_LYRIC_LANGUAGE),
  customLanguage: z.string().trim().max(60).default(""),
  customMode: z.boolean().default(false),
  model: z.enum(SUNO_MODELS).default("V4_5"),
  /** Ignored. Kept so older clients that still send an engine id do not 400. */
  engine: z.enum(["minimax", "hybrid", "elevenlabs"]).optional(),
  /** Target length in seconds. Clamped to the master ceiling on the server. */
  durationSeconds: z.number().int().min(10).max(MINIMAX_MAX_SECONDS).optional(),
  /** Ignored. Kept for older clients. */
  allowReslice: z.boolean().optional(),
  controls: controlsSchema.optional(),
  /** Core style/genre tags from the studio — not rewritten to a stock genre. */
  genre: z.string().trim().max(600).optional(),
  mood: z.string().trim().max(400).optional(),
  instruments: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  /** Default-AI vocal character (Aggressive Rock Vocal, Female Vocal, …). */
  vocalProfile: z.string().trim().max(400).optional(),
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

const taskSchema = z.object({ taskId: z.string().trim().min(1).max(200) });

export const generateEngineTrack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    const parsed = generateSchema.safeParse(data);
    if (parsed.success) return parsed.data;
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? issue.path.join(".") : "payload";
    throw new Error(`Track setup: ${path} ${issue?.message ?? "was out of range"}`);
  })
  .handler(async ({ data, context }) => {
    limitBy("generateEngineTrack", context.userId, RATE_LIMITS.generation, "track generations");
    const { DEV_TEST_VOICE_ID, isDevAuthBypass } = await import("@/lib/dev-auth");
    if (!isDevAuthBypass()) {
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

    const {
      archiveGeneratedAudio,
      checkApiframeHealth,
      newCorrelationId,
    } = await import("@/lib/apiframe.server");
    const { engineCreditErrorMessage } = await import("@/lib/engine-credits");
    const {
      buildDynamicStylePrompt,
      concatStylePromptWithLyrics,
      logApiPayload,
    } = await import("@/lib/generation-style-prompt");
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
    const stylePrompt = buildDynamicStylePrompt({
      genre,
      bpm,
      mood,
      instruments,
      vocalProfile: payload.instrumental ? undefined : vocalProfile,
    });
    const lyricContent = payload.instrumental ? "" : payload.lyrics;
    const combinedPrompt = concatStylePromptWithLyrics(stylePrompt, lyricContent);
    const { generateTimedHybridTrack } = await import("@/lib/hybrid-track-pipeline.server");
    const correlationId = newCorrelationId("gen");

    let referenceSampleUrl = payload.referenceAudioUrl?.trim() || undefined;
    const voiceId = payload.voiceId?.trim() || undefined;
    const customVoiceRequested = Boolean(voiceId) && !payload.instrumental;
    if (customVoiceRequested) {
      const { VOCAL_CONSENT_REQUIRED_MESSAGE } = await import("@/lib/vocal-consent");
      if (!payload.termsAccepted) {
        throw new Error(VOCAL_CONSENT_REQUIRED_MESSAGE);
      }
      const isDevTestVoice = voiceId === DEV_TEST_VOICE_ID && isDevAuthBypass();
      if (!referenceSampleUrl && !isDevTestVoice) {
        const { data: profile } = await context.supabase
          .from("voice_profiles")
          .select("sample_url")
          .eq("user_id", context.userId)
          .eq("voice_id", voiceId)
          .maybeSingle();
        referenceSampleUrl = profile?.sample_url ?? undefined;
      }
      if (!referenceSampleUrl && !isDevTestVoice) {
        throw new Error("That saved voice could not be loaded. Record or upload it again.");
      }
    }

    logApiPayload({
      stylePrompt,
      prompt: combinedPrompt,
      lyrics: lyricContent,
      genre,
      bpm: bpm ?? null,
      mood: mood || null,
      instruments,
      vocalProfile: vocalProfile || null,
      voice_id: voiceId ?? null,
      reference_audio: referenceSampleUrl ?? null,
      instrumental: payload.instrumental,
      language: payload.language,
      customLanguage: payload.customLanguage,
      audioFormat: payload.audioFormat,
      durationSeconds,
    });

    // Platform render credits are a separate meter from Hybrid Tokens. Check
    // them before starting so an exhausted account produces an accurate,
    // token-safe warning instead of a hard mid-render failure.
    const health = await checkApiframeHealth(correlationId).catch(() => null);
    if (health?.creditsExhausted) {
      throw new Error(engineCreditErrorMessage(health.reason));
    }

    const timed = await generateTimedHybridTrack(
      {
        introPrompt: `${stylePrompt}. 30-second producer tag intro, radio ident.`,
        mainStylePrompt: stylePrompt,
        lyricContent,
        totalDurationSec: durationSeconds,
        audioFormat: payload.audioFormat,
        title: payload.title,
        language: payload.language,
        customLanguage: payload.customLanguage,
        userId: context.userId,
        voiceId,
        referenceSampleUrl,
        bpm,
        preserveUserPrompt: true,
      },
      correlationId,
    );
    const rawTracks = [
      {
        id: timed.taskIds.vocals,
        title: payload.title || "Vocal stem",
        audioUrl: timed.vocalStem,
        imageUrl: null,
        duration: durationSeconds,
      },
      {
        id: timed.taskIds.instrumental,
        title: payload.title ? `${payload.title} instrumental` : "Instrumental",
        audioUrl: timed.instrumentalStem,
        imageUrl: null,
        duration: durationSeconds,
      },
      {
        id: timed.taskIds.intro,
        title: payload.title ? `${payload.title} intro` : "Intro tag",
        audioUrl: timed.introStem,
        imageUrl: null,
        duration: 30,
      },
    ].filter((track) => track.audioUrl);
    const tracks = await Promise.all(
      rawTracks.map(async (track) => ({
        ...track,
        audioUrl: track.audioUrl
          ? await archiveGeneratedAudio(
              track.audioUrl,
              context.userId,
              track.id ?? correlationId,
            ).catch(() => null)
          : null,
      })),
    );

    const urlFor = (taskId: string | null) =>
      tracks.find((track) => track.id === taskId)?.audioUrl ?? null;
    const vocalUrl = urlFor(timed.taskIds.vocals);
    const instrumentalUrl = urlFor(timed.taskIds.instrumental);
    const introUrl = urlFor(timed.taskIds.intro);

    const sourceMasterUrl = vocalUrl ?? instrumentalUrl ?? introUrl;
    let masterUrl = sourceMasterUrl;
    const taskId = timed.taskIds.vocals ?? timed.taskIds.instrumental ?? timed.taskIds.intro ?? correlationId;

    try {
      const { mixAndMasterHybridTrack } = await import("@/lib/matchering-master.server");
      const mastered = await mixAndMasterHybridTrack({
        introUrl,
        instrumentalUrl,
        vocalUrl,
        userId: context.userId,
        taskId,
      });
      if (mastered.masterUrl) masterUrl = mastered.masterUrl;
    } catch (error) {
      console.warn(
        "[matchering] generate fallback to raw stem",
        error instanceof Error ? error.message : error,
      );
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
      status: masterUrl ? "completed" : "processing",
      masterUrl,
      instrumentalUrl,
      vocalUrl,
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
      });
    }

    const playableTracks = masterUrl
      ? [
          {
            id: `${taskId}-master`,
            title: payload.title || "Mastered track",
            audioUrl: masterUrl,
            imageUrl: null,
            duration: durationSeconds,
          },
          ...tracks,
        ]
      : tracks;

    return {
      taskId,
      status: masterUrl ? "completed" : "processing",
      tracks: playableTracks,
      stems: {
        masterUrl,
        instrumentalUrl,
        vocalUrl,
        introUrl,
      },
      correlationId,
      cached: false,
      engine: "hybrid" as const,
      requestedEngine: "hybrid" as const,
      durationSeconds,
      routingNote: null,
    };
  });



export const getEngineTrackTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => taskSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { archiveGeneratedAudio, fetchApiframeTask, newCorrelationId } = await import("@/lib/apiframe.server");
    const correlationId = newCorrelationId("poll");
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
  });

/** Preflight check so the studio can warn before anyone starts a generation. */
export const checkEngineHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { checkApiframeHealth, newCorrelationId } = await import("@/lib/apiframe.server");
    const correlationId = newCorrelationId("health");
    return { ...(await checkApiframeHealth(correlationId)), correlationId };
  });
