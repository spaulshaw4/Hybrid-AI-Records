import { replicateBaseUrl, replicateHeaders } from "@/lib/ai-provider.server";
/**
 * Visual engine stack (server only).
 *
 * The routing is fixed and vendor names never leave this module:
 *   - Visual foundation & cross-shot identity: Seedream 5.0, with Flux 3 as the
 *     photographic-texture stand-in when Seedream is unavailable.
 *   - Cinematic motion: Seedance 2.0 — the single default workhorse, driving
 *     the scene under the active Genre Visual Laws.
 *   - Fail-safe: Wan 2.2, a silent redundancy node. It receives the exact same
 *     genre-locked prompt and never rewrites or relaxes it.
 *
 * Every call is capped to the native 1080p target from `render-resolution`.
 */

import {
  MAX_BLOCK_SECONDS,
  NATIVE_RENDER_RESOLUTION,
  clampResolutionLanguage,
} from "@/lib/render-resolution";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { GLOBAL_NEGATIVE_PROMPT } from "@/lib/global-negative-prompt";
import { describeDispatchIssues, validateDispatchPayload } from "@/lib/dispatch-schema";



/** Still-frame engines: foundation first, photographic fallback second. */
const FOUNDATION_MODELS = [
  process.env["SEEDREAM_MODEL"] || "bytedance/seedream-4",
  process.env["FLUX_MODEL"] || "black-forest-labs/flux-1.1-pro",
] as const;

/**
 * Motion matrix — lean profile.
 *
 * Seedance 2.0 is the single default workhorse for ALL cinematic motion and
 * character-consistent generation. The parallel high-cost nodes (omni-modal
 * MiniMax H3, Runway Gen-4 Turbo, Kling Motion, Wan 2.5 wide) are out of the
 * standard path so a normal render never fans out across several billed
 * vendors. Only one redundancy node remains: Wan 2.2, which secures the queue
 * on a 429 / 503 so a rate limit can never break a job.
 */
const MOTION_NODES = {
  /** Default workhorse — character performance, action and environment alike. */
  performance: { id: "primary" as const, model: process.env["SEEDANCE_MODEL"] || "bytedance/seedance-1-pro" },
  /** Sole redundancy fallback — secures the queue on rate limits / outages. */
  fallbackTwo: { id: "reserve" as const, model: process.env["WAN_MODEL"] || "wan-video/wan-2.2-i2v-fast" },
};

type MotionNode = { id: MotionEngineId; model: string; omni?: true };

/** Which motion class a shot belongs to. */
export type ShotClass = "performance" | "action" | "environment";

export type MotionEngineId = "primary" | "backup" | "reserve";

/**
 * Dispatch order. Every shot class runs the same lean chain: Seedance 2.0,
 * then Wan 2.2 as the single fallback.
 */
function motionChain(_shotClass: ShotClass): MotionNode[] {
  return [MOTION_NODES.performance, MOTION_NODES.fallbackTwo];
}


/**
 * Circuit breaker around the paid endpoints (Seedance 2.0 and the single Wan
 * 2.2 redundancy node). Shared implementation: 3 consecutive failures (or an
 * immediate 429 / 503) trips the node open for 60s so the very next shot
 * skips straight to the fallback cascade, then a single half-open probe
 * recovers it once the upstream stabilises.
 */
import {
  shouldSkip as breakerOpen,
  recordFailure,
  recordSuccess,
} from "@/lib/circuit-breaker.server";





export class VisualEngineError extends Error {
  status: number | null;
  detail: string;
  constructor(message: string, status: number | null, detail: string) {
    super(message);
    this.name = "VisualEngineError";
    this.status = status;
    this.detail = detail;
  }
}

function credentials(): Record<string, string> {
  try {
    return replicateHeaders("The visual engine");
  } catch (err) {
    throw new VisualEngineError(
      err instanceof Error ? err.message : "The visual engine is not configured yet.",
      null,
      "",
    );
  }
}

export type Prediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
  /** Provider stdout — most motion models emit a percentage here. */
  logs?: string | null;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
};

/**
 * Best-effort completion percentage for a running prediction.
 *
 * Motion engines stream progress into `logs` in a handful of shapes
 * (`42%`, `12/30`, `step 12 of 30`). When nothing is parseable we fall back to
 * an elapsed-time curve that eases towards 90% so the UI always advances
 * instead of sitting frozen on a single number.
 */
export function predictionProgress(prediction: Prediction): number {
  if (prediction.status === "succeeded") return 100;
  if (prediction.status === "starting") return 5;

  const logs = typeof prediction.logs === "string" ? prediction.logs.slice(-4000) : "";
  if (logs) {
    const percents = [...logs.matchAll(/(\d{1,3})\s?%/g)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
    if (percents.length) return Math.max(8, Math.min(99, percents[percents.length - 1]!));

    const steps = [...logs.matchAll(/(?:step\s*)?(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})/gi)]
      .map((m) => ({ done: Number(m[1]), total: Number(m[2]) }))
      .filter((s) => s.total > 0 && s.done >= 0 && s.done <= s.total);
    if (steps.length) {
      const last = steps[steps.length - 1]!;
      return Math.max(8, Math.min(99, Math.round((last.done / last.total) * 100)));
    }
  }

  const startedAt = prediction.started_at ?? prediction.created_at;
  const elapsed = startedAt ? (Date.now() - Date.parse(startedAt)) / 1000 : 0;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 10;
  // ~90 second typical block: asymptotic ease so it never claims completion.
  return Math.max(10, Math.min(90, Math.round(90 * (1 - Math.exp(-elapsed / 60)))));
}


async function startPrediction(model: string, input: Record<string, unknown>): Promise<Prediction> {
  let response: Response;
  try {
    // Breaker bookkeeping happens in createMotionBlock, so this layer only
    // supplies timeout + network retry.
    response = await resilientFetch(
      `${replicateBaseUrl()}/models/${model}/predictions`,
      { method: "POST", headers: credentials(), body: JSON.stringify({ input }) },
      { label: `motion dispatch (${model})`, timeoutMs: 180_000, retries: 0, useBreaker: false },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VisualEngineError(`Render dispatch could not reach the engine — ${reason}`, null, reason);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = "";
    try {
      const parsed = JSON.parse(body) as { detail?: string; title?: string };
      message = parsed.detail || parsed.title || "";
    } catch {
      message = "";
    }
    throw new VisualEngineError(
      response.status === 402
        ? `The render provider refused the job: payment required / out of credits [402]${
            message ? ` — ${message}` : ""
          }`
        : `Render rejected [${response.status}]${message ? ` — ${message}` : ""}`,
      response.status,
      (message || body).slice(0, 600),
    );
  }
  return (await response.json()) as Prediction;
}

export async function readPrediction(id: string): Promise<Prediction> {
  let response: Response;
  try {
    response = await resilientFetch(
      `${replicateBaseUrl()}/predictions/${id}`,
      { headers: credentials() },
      { label: `render poll (${id})`, timeoutMs: 45_000, retries: 0, baseDelayMs: 1000, useBreaker: false },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VisualEngineError(`Render job could not be read — ${reason}`, null, reason);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new VisualEngineError(
      `Render job could not be read [${response.status}].`,
      response.status,
      body.slice(0, 400),
    );
  }
  return (await response.json()) as Prediction;
}


/** Replicate returns either a URL string or an array of them. */
export function firstOutputUrl(output: unknown): string | null {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const hit = output.find((entry) => typeof entry === "string");
    return typeof hit === "string" ? hit : null;
  }
  return null;
}

async function waitFor(id: string, timeoutMs: number): Promise<Prediction> {
  const started = Date.now();
  for (;;) {
    const prediction = await readPrediction(id);
    if (prediction.status === "succeeded") return prediction;
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new VisualEngineError(
        prediction.error || "The visual engine failed on this frame.",
        null,
        prediction.error ?? "",
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new VisualEngineError("The visual engine timed out on this frame.", null, "");
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

/**
 * Stage 1 — scene keyframe.
 *
 * Builds a single 16:9 cinematic frame for the shot. Character reference
 * sheets (triptych / turnaround) are passed here ONLY as face-identity
 * references (IP-Adapter style conditioning) — never as a video start frame.
 * Returns null rather than throwing: motion can still run text-to-video.
 */
export async function createFoundationFrame(
  prompt: string,
  identityReferences?: string[] | undefined,
): Promise<string | null> {
  const safePrompt = clampResolutionLanguage(prompt).slice(0, 1800);
  const refs = (identityReferences ?? []).filter(Boolean).slice(0, 4);
  for (const model of FOUNDATION_MODELS) {
    try {
      const started = await startPrediction(model, {
        prompt: safePrompt,
        negative_prompt: GLOBAL_NEGATIVE_PROMPT,
        aspect_ratio: "16:9",
        output_format: "jpg",
        // Identity conditioning only — the sheet informs the face, it is not
        // reproduced as the frame itself.
        ...(refs.length ? { image_input: refs, reference_images: refs } : {}),
      });
      const done = await waitFor(started.id, 180_000);
      const url = firstOutputUrl(done.output);
      if (url) return url;
    } catch (error) {
      console.error("[visual] scene keyframe failed:", error);
    }
  }
  return null;
}

export type MotionJob = { id: string; status: string; progress: number; engine: MotionEngineId };

/**
 * Dispatches one cinematic motion block. `referenceImage` is the identity
 * anchor (uploaded character photo or a foundation frame) the shot animates
 * from. `styleReferences` and `audioReference` are the extra context the
 * omni-modal node consumes in the same pass — character/style anchors plus the
 * master stereo track, so the primary shot comes back already in sync.
 * The prompt — including its Genre Visual Laws negative block — is passed
 * through untouched to every engine in the cascade.
 */
export async function createMotionBlock(input: {
  prompt: string;
  seconds: number;
  referenceImage?: string | undefined;
  styleReferences?: string[] | undefined;
  audioReference?: string | undefined;
  shotClass?: ShotClass | undefined;
}): Promise<MotionJob> {
  const seconds = Math.max(4, Math.min(MAX_BLOCK_SECONDS, Math.round(input.seconds)));
  const prompt = clampResolutionLanguage(input.prompt);
  // `styleReferences` (character sheets / photos) are deliberately NOT sent to
  // the motion model — they are consumed in Stage 1 keyframe generation only.
  let lastError: VisualEngineError | null = null;

  const chain = motionChain(input.shotClass ?? "performance");
  // Evaluate each node once — a half-open node consumes its single probe slot
  // on this call, so it must not be re-checked below.
  const health = chain.map((engine) => ({ engine, skip: breakerOpen(engine.model) }));
  // Everything cooling down at once would leave nothing to dispatch, so only
  // skip open nodes while at least one healthy node remains.
  const healthy = health.filter((h) => !h.skip).map((h) => h.engine);
  const usable = healthy.length > 0 ? healthy : chain;


  for (const engine of usable) {
    // Lean single-vendor payload — one billed node per shot, no omni fan-out.
    // `referenceImage` here is ALWAYS a single 16:9 scene keyframe produced by
    // Stage 1 — never a character turnaround sheet, which would make the model
    // animate the sheet layout itself.
    const payload: Record<string, unknown> = {
      prompt,
      negative_prompt: GLOBAL_NEGATIVE_PROMPT,
      duration: seconds,
      resolution: NATIVE_RENDER_RESOLUTION,
      aspect_ratio: "16:9",
      ...(input.referenceImage
        ? { image: input.referenceImage, start_image: input.referenceImage }
        : {}),
      // The master track slice under this shot rides along so the returned MP4
      // already carries the active audio stream (no post-hoc mux needed).
      ...(input.audioReference
        ? { audio: input.audioReference, audio_url: input.audioReference }
        : {}),
    };


    // Schema pre-flight: never spend a dispatch on a body the model rejects.
    const schema = validateDispatchPayload(payload);
    if (!schema.ok) {
      const detail = describeDispatchIssues(schema.issues);
      console.error("[visual] dispatch payload rejected by schema pre-flight:", schema.issues);
      throw new VisualEngineError(`Render payload failed schema validation — ${detail}`, 400, detail);
    }

    // No automatic retry loop: one dispatch per engine, then the cascade.
    // Retrying a failed generation silently doubles the render bill.
    try {
      const prediction = await startPrediction(engine.model, payload);
      recordSuccess(engine.model);
      return { id: prediction.id, status: prediction.status, progress: 0, engine: engine.id };
    } catch (error) {
      const failure =
        error instanceof VisualEngineError
          ? error
          : new VisualEngineError(
              error instanceof Error ? error.message : "Render dispatch failed",
              null,
              "",
            );
      lastError = failure;
      recordFailure(engine.model, failure.status);
      console.error(`[visual] motion dispatch failed on ${engine.id}:`, failure.message);
      // Billing stops are terminal everywhere — never burn the fail-safe on them.
      if (failure.status === 402) throw failure;
    }

  }



  throw lastError ?? new VisualEngineError("No visual engine is available right now.", null, "");
}

/**
 * No cloud enhancement/upscale node exists in this pipeline. The master ships
 * at the native 1080p render — picture quality passes are not billed out.
 */

/**
 * Cancels a running prediction so an aborted job stops billing compute
 * immediately instead of running to completion unwatched.
 */
export async function cancelPrediction(id: string): Promise<boolean> {
  try {
    const response = await resilientFetch(
      `${replicateBaseUrl()}/predictions/${id}/cancel`,
      { method: "POST", headers: credentials() },
      { label: `render cancel (${id})`, timeoutMs: 30_000, retries: 0, useBreaker: false },
    );
    if (!response.ok) {
      console.error(`[visual] cancel failed [${response.status}] for ${id}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[visual] cancel unreachable:", error);
    return false;
  }
}
