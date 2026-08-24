import { createServerFn } from "@tanstack/react-start";
import { checkRateLimit, limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sanitizeCharacterProfile } from "@/lib/character-profile";
import { isLocalMock, isMockJobId, mockJobId, mockPlan, MOCK_VIDEO_URL } from "@/lib/local-mock";

export type CinematicStartResult =
  | {
      ok: true;
      tokens: number;
      /** Tokens actually deducted (0 on a beta grace render). */
      charged: number;
      /** True when the beta let the render through without a full charge. */
      granted: boolean;
      seconds: number;

      balance: number;
      logline: string;
      soundtrack: string;
      scenes: {
        index: number;
        title: string;
        shot: string;
        seconds: number;
        vocalSync?: boolean;
      }[];
      jobId: string;
      engine: "primary" | "backup" | "reserve";
      /** Governing Genre Visual Law, reused by every later shot render. */
      genreId: string | null;
      genreLabel: string | null;
    }
  | { ok: false; error: string; balance?: number };

/** Keeps only well-formed, reasonably sized base64 image data URLs. */
function sanitizeReferenceImages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter(
      (v): v is string =>
        typeof v === "string" &&
        /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) &&
        v.length <= 3_000_000,
    )
    .slice(0, 3);
}

/** Normalises the browser-derived musical timing map for story mode. */
const SECTION_LABELS = [
  "intro",
  "build",
  "verse",
  "chorus",
  "drop",
  "breakdown",
  "outro",
] as const;

function sanitizeAudioTiming(input: unknown) {
  const t = input as
    | {
        durationSeconds?: unknown;
        bpm?: unknown;
        cuts?: unknown;
        energy?: unknown;
        sections?: unknown;
      }
    | null
    | undefined;
  if (!t || !Array.isArray(t.cuts) || t.cuts.length < 2) return undefined;
  const cuts = t.cuts
    .filter((c): c is number => typeof c === "number" && Number.isFinite(c) && c > 0)
    .slice(0, 120)
    .sort((a, b) => a - b);
  if (cuts.length < 2) return undefined;
  const energy = Array.isArray(t.energy)
    ? t.energy
        .filter((e): e is number => typeof e === "number" && Number.isFinite(e))
        .slice(0, 120)
        .map((e) => Math.max(0, Math.min(1, e)))
    : [];
  const duration = typeof t.durationSeconds === "number" && Number.isFinite(t.durationSeconds)
    ? Math.max(1, Math.min(3600, t.durationSeconds))
    : cuts[cuts.length - 1]!;
  const bpm = typeof t.bpm === "number" && Number.isFinite(t.bpm) ? Math.round(t.bpm) : null;
  const sections = Array.isArray(t.sections)
    ? (t.sections as Array<Record<string, unknown>>)
        .slice(0, 40)
        .map((s) => ({
          start: Math.max(0, Number(s["start"]) || 0),
          end: Math.max(0, Number(s["end"]) || 0),
          label:
            SECTION_LABELS.find((l) => l === s["label"]) ?? ("verse" as (typeof SECTION_LABELS)[number]),
          energy: Math.max(0, Math.min(1, Number(s["energy"]) || 0)),
        }))
        .filter((s) => s.end > s.start)
    : [];
  return { durationSeconds: duration, bpm, cuts, energy, sections };
}


/**
 * Starts a V Engine cinematic render: charges V Tokens server-side from the
 * requested duration, parses the script into scene blocks, then dispatches the
 * opening render with automatic engine failover. Character reference photos are
 * carried into the render as the opening frame so faces stay consistent, and in
 * story mode the uploaded song's timing map drives every scene cut.
 */
export const startCinematicRender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    (data: {
      script: string;
      subjectMode: string;
      styleMode: string;
      durationSeconds: number;
      characterPhotos?: string[];
      character?: {
        name?: string;
        archetype?: string;
        appearance?: string;
        referenceImage?: string | null;
      } | null;
      moodBoard?: { grade?: string; references?: string[]; notes?: string };
      genreOverride?: string | null;
      moodOverride?: string | null;
      audioTiming?: {
        durationSeconds: number;
        bpm: number | null;
        cuts: number[];
        energy: number[];
        sections?: { start: number; end: number; label: string; energy: number }[];
      };

    }) => {
      if (typeof data?.script !== "string" || data.script.trim().length < 40) {
        throw new Error("Add a longer script before rendering.");
      }
      if (typeof data?.durationSeconds !== "number" || !Number.isFinite(data.durationSeconds)) {
        throw new Error("Invalid duration");
      }
      const mood = data.moodBoard ?? {};
      return {
        script: data.script.slice(0, 15000),
        subjectMode: String(data.subjectMode ?? "people").slice(0, 40),
        styleMode: String(data.styleMode ?? "photorealistic").slice(0, 40),
        durationSeconds: data.durationSeconds,
        characterPhotos: sanitizeReferenceImages(data.characterPhotos),
        character: sanitizeCharacterProfile(data.character),
        genreOverride:
          typeof data.genreOverride === "string" && data.genreOverride.trim()
            ? data.genreOverride.trim().slice(0, 40)
            : null,
        moodOverride:
          typeof data.moodOverride === "string" ? data.moodOverride.trim().slice(0, 120) : "",
        audioTiming: sanitizeAudioTiming(data.audioTiming),
        moodBoard: {
          grade: typeof mood.grade === "string" ? mood.grade.slice(0, 40) : undefined,
          references: Array.isArray(mood.references)
            ? mood.references
                .filter((r): r is string => typeof r === "string")
                .slice(0, 20)
                .map((r) => r.slice(0, 40))
            : [],
          notes: typeof mood.notes === "string" ? mood.notes.slice(0, 600) : "",
        },
      };
    },
  )


  .handler(async ({ data, context }): Promise<CinematicStartResult> => {
    limitBy("startCinematicRender", context.userId, RATE_LIMITS.generation, "render starts");
    // Local mock mode: no wallet check, no upstream dispatch, no 402s.
    if (isLocalMock()) {
      const plan = mockPlan(data.durationSeconds);
      return {
        ok: true,
        tokens: 0,
        charged: 0,
        granted: true,
        seconds: data.durationSeconds,
        balance: 0,
        logline: plan.logline,
        soundtrack: plan.soundtrack,
        scenes: plan.scenes,
        genreId: data.genreOverride,
        genreLabel: data.genreOverride,
        jobId: mockJobId(),
        engine: "primary",
      };
    }
    const { chargeVRender } = await import("@/lib/v-render-charge.server");
    const quote = await chargeVRender(context.userId, data.durationSeconds);

    if (!quote.ok) {
      return {
        ok: false,
        error: quote.error ?? "Couldn't charge V Tokens. Try again.",
        balance: quote.balance,
      };
    }

    const balance = quote.balance;


    try {
      const { planCinematicScript, createVisualRender } = await import(
        "@/lib/cinematic-pipeline.server"
      );
      const plan = await planCinematicScript({
        script: data.script,
        subjectMode: data.subjectMode,
        styleMode: data.styleMode,
        durationSeconds: quote.seconds,
        audioTiming: data.audioTiming,
        moodBoard: data.moodBoard,
        genreOverride: data.genreOverride,
        moodOverride: data.moodOverride,
        character: data.character,
      });


      // The Character Builder avatar is the primary visual conditioning image.
      const anchorImage = data.character?.referenceImage ?? data.characterPhotos[0];
      const opening = plan.scenes[0]!;
      const openingSeconds = (opening.seconds >= 8 ? 8 : opening.seconds >= 6 ? 6 : 4) as 4 | 6 | 8;
      const job = await createVisualRender(
        opening.shot,
        openingSeconds,
        anchorImage ?? undefined,
        plan.genreId,
        // Unified multimodal context: every character/style anchor travels with
        // the shot so the omni-modal node locks identity in one pass.
        { styleReferences: data.characterPhotos.slice(0, 4) },
      );




      return {
        ok: true,
        tokens: quote.tokens,
        charged: quote.charged,
        granted: quote.granted,
        seconds: quote.seconds,
        balance,
        logline: plan.logline,
        soundtrack: plan.soundtrack,
        scenes: plan.scenes,
        genreId: plan.genreId,
        genreLabel: plan.genreLabel,
        jobId: job.id,
        engine: job.engine,
      };

    } catch (err) {
      console.error("Cinematic render failed:", err);
      return {
        ok: false,
        error: err instanceof Error ? err.message : "The render pipeline failed. Try again.",
        balance,
      };
    }
  });

/**
 * Dispatches one scene block of an already-planned render.
 *
 * This never touches the V Token wallet: the whole project is charged exactly
 * once in `startCinematicRender`, so retrying or resuming individual shots is
 * always free.
 */
export const renderCinematicScene = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: {
    shot: string;
    seconds: number;
    referenceImage?: string;
    genreId?: string | null;
    styleReferences?: string[];
    /** `data:audio/...;base64,...` slice of the master track under this shot. */
    audioReference?: string;
  }) => {
    if (typeof data?.shot !== "string" || data.shot.trim().length < 10) {
      throw new Error("Invalid scene prompt");
    }
    const seconds = Math.max(4, Math.min(8, Math.round(Number(data.seconds) || 8)));
    const [referenceImage] = sanitizeReferenceImages([data.referenceImage]);
    return {
      shot: data.shot.slice(0, 1500),
      seconds: (seconds >= 8 ? 8 : seconds >= 6 ? 6 : 4) as 4 | 6 | 8,
      referenceImage,
      genreId: typeof data.genreId === "string" ? data.genreId.slice(0, 40) : null,
      styleReferences: sanitizeReferenceImages(
        Array.isArray(data.styleReferences) ? data.styleReferences.slice(0, 4) : [],
      ),
      audioReference:
        typeof data.audioReference === "string" && /^data:audio\//i.test(data.audioReference)
          ? data.audioReference
          : undefined,
    };
  })
  .handler(async ({ data, context }) => {
    if (isLocalMock()) {
      return { ok: true as const, jobId: mockJobId(), engine: "primary" as const };
    }
    // Paid route: the caller's Video Token balance is verified and deducted
    // BEFORE a single request touches GOOGLE_PAID_API_KEY or the engines.
    const { requireVideoTokens } = await import("@/lib/v-render-charge.server");
    const quote = await requireVideoTokens(
      context.userId,
      data.seconds,
      `shot:${context.userId}:${data.shot.slice(0, 40)}:${data.seconds}`,
    );
    if (!quote.ok) {
      return {
        ok: false as const,
        error: quote.error ?? "Not enough Video Tokens for this shot.",
        status: 402,
        detail: "",
        source: "wallet" as const,
      };
    }

    try {
      const { createVisualRender } = await import("@/lib/cinematic-pipeline.server");
      const job = await createVisualRender(
        data.shot,
        data.seconds,
        data.referenceImage,
        data.genreId,
        {
          styleReferences: data.styleReferences,
          ...(data.audioReference ? { audioReference: data.audioReference } : {}),
        },
      );
      return { ok: true as const, jobId: job.id, engine: job.engine };
    } catch (err) {
      const status =
        err && typeof err === "object" && "status" in err
          ? ((err as { status: number | null }).status ?? null)
          : null;
      const detail =
        err && typeof err === "object" && "detail" in err
          ? String((err as { detail?: string }).detail ?? "")
          : "";
      console.error("Cinematic scene dispatch failed:", { status, detail, err });
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : "The scene render failed.",
        status,
        detail,
        // Distinguishes an external provider billing stop from our own wallet.
        source: (status === 402 ? "provider-credit" : "provider") as
          | "provider-credit"
          | "provider"
          | "wallet",
      };
    }
  });


/** Live poll payload handed to the studio UI. */
export type CinematicPollResult = {
  status: "in_progress" | "completed" | "failed";
  stage: "starting" | "processing" | "succeeded" | "failed";
  progress: number;
  videoUrl: string | null;
  previewUrl?: string | null;
  error?: string;
};

/** Polls a running render; returns a playable URL once the master is archived. */

export const pollCinematicRender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { jobId: string }) => {
    if (typeof data?.jobId !== "string" || !/^[A-Za-z0-9_.-]{4,120}$/.test(data.jobId)) {
      throw new Error("Invalid jobId");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<CinematicPollResult> => {
    // Polling is a cheap read, not a paid dispatch: it gets its own generous
    // window and never throws — a throttled poll just reports "still working".
    const poll = checkRateLimit({
      key: `pollCinematicRender:${context.userId}`,
      limit: 120,
      windowMs: 60_000,
    });
    if (!poll.allowed) {
      return { status: "in_progress", stage: "processing", progress: 0, videoUrl: null };
    }
    if (isLocalMock() || isMockJobId(data.jobId)) {
      return {
        status: "completed",
        stage: "succeeded",
        progress: 100,
        videoUrl: MOCK_VIDEO_URL,
      };
    }
    const { pollVisualRender } = await import("@/lib/cinematic-pipeline.server");
    try {
      return await pollVisualRender(data.jobId, context.userId);
    } catch (err) {
      // A poll must never crash the session: always hand back a readable state.
      console.error("Cinematic poll failed:", err);
      return {
        status: "failed",
        stage: "failed",
        progress: 0,
        videoUrl: null,
        error: err instanceof Error ? err.message : "The render failed.",
      };
    }
  });

/**
 * Cancels a running prediction. Called when the producer aborts a job so the
 * pending block stops consuming provider compute right away.
 */
export const cancelCinematicRender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { jobId: string }) => {
    if (typeof data?.jobId !== "string" || !/^[A-Za-z0-9_.-]{4,120}$/.test(data.jobId)) {
      throw new Error("Invalid jobId");
    }
    return { jobId: data.jobId };
  })
  .handler(async ({ data }) => {
    if (isLocalMock() || isMockJobId(data.jobId)) return { ok: true as const, canceled: true };
    try {
      const { cancelPrediction } = await import("@/lib/visual-engines.server");
      const canceled = await cancelPrediction(data.jobId);
      return { ok: true as const, canceled };
    } catch (err) {
      console.error("Cinematic cancel failed:", err);
      return { ok: false as const, canceled: false };
    }
  });
