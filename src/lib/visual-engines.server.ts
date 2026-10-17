import { wavespeedHeaders } from "@/lib/ai-provider.server";
/**
 * Visual engine stack (server only) — WaveSpeed.
 *
 * Vendor names never leave this module:
 *   - Stills: `wavespeed-ai/flux-dev`. flux-pro has no confirmed path and is
 *     not called.
 *   - Motion: Hailuo 2.3 i2v-standard and Seedance 2.5 image-to-video.
 *     There is no Replicate, Wan, or other fallback.
 *
 * Duration selection lives only in `resolveCinematicMotion`. Hailuo accepts
 * 6 and 10. Seedance accepts 4–30, including 5. Five seconds is never sent
 * to Hailuo.
 *
 * Submit: POST /api/v3/{model-path}. Poll: GET /api/v3/predictions/{id}/result.
 * The media URL is data.outputs[0]. Auth is WAVESPEED_API_KEY as Bearer.
 */

import {
  MAX_BLOCK_SECONDS,
  NATIVE_RENDER_RESOLUTION,
  clampResolutionLanguage,
} from "@/lib/render-resolution";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { GLOBAL_NEGATIVE_PROMPT } from "@/lib/global-negative-prompt";
import {
  isWaveSpeedFailure,
  isWaveSpeedSuccess,
  redactSecrets,
  waveSpeedData,
  waveSpeedErrorText,
  waveSpeedId,
  waveSpeedModelUrl,
  waveSpeedOutputUrl,
  waveSpeedResultUrl,
  waveSpeedStatus,
} from "@/lib/wavespeed-prediction.server";
import {
  recordFailure,
  recordSuccess,
  shouldSkip as breakerOpen,
} from "@/lib/circuit-breaker.server";

/** Confirmed still model. */
export const FLUX_DEV_MODEL = "wavespeed-ai/flux-dev";

/** 16:9 size confirmed for flux-dev (`width*height`, each side 256–1536). */
export const FLUX_DEV_SIZE_16_9 = "1024*576";

/** Confirmed motion models. */
export const HAILUO_I2V_MODEL = "minimax/hailuo-2.3/i2v-standard";
export const SEEDANCE_I2V_MODEL = "bytedance/seedance-2.5/image-to-video";

/** Which motion class a shot belongs to. Routing itself is by duration. */
export type ShotClass = "performance" | "action" | "environment";

export type MotionEngineId = "primary" | "backup" | "reserve";

export type ResolvedMotion = {
  id: MotionEngineId;
  model: string;
  duration: number;
};

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
    return wavespeedHeaders("The visual engine");
  } catch (err) {
    throw new VisualEngineError(
      err instanceof Error ? err.message : "The visual engine is not configured yet.",
      null,
      "",
    );
  }
}

/**
 * Hailuo 2.3 i2v-standard accepts only 6 and 10. Any other length, including
 * 5, throws here — it is not rewritten to 6 or 10.
 */
export function assertHailuoDuration(duration: number): 6 | 10 {
  if (duration === 6 || duration === 10) return duration;
  throw new VisualEngineError(
    `Hailuo 2.3 accepts only 6 or 10 seconds. Refusing to send ${duration}.`,
    400,
    "duration",
  );
}

/**
 * The only duration map for cinematic motion.
 *
 * Requested seconds are clamped to 4–10, then left unchanged:
 *   - 6 and 10 → Hailuo, then Seedance at the same duration if Hailuo fails
 *   - 4, 5, 7, 8, and 9 → Seedance only
 *
 * Seedance 2.5 image-to-video accepts 4–30 (default 5). A 5-second request
 * stays on Seedance. It is not sent to Hailuo.
 */
export function resolveCinematicMotion(seconds: number): ResolvedMotion[] {
  const duration = Math.max(4, Math.min(MAX_BLOCK_SECONDS, Math.round(seconds)));
  if (!Number.isFinite(duration)) {
    throw new VisualEngineError("Block duration must be a number of seconds.", 400, "duration");
  }
  if (duration === 6 || duration === 10) {
    const hailuoDuration = assertHailuoDuration(duration);
    return [
      { id: "primary", model: HAILUO_I2V_MODEL, duration: hailuoDuration },
      { id: "reserve", model: SEEDANCE_I2V_MODEL, duration: hailuoDuration },
    ];
  }
  return [{ id: "primary", model: SEEDANCE_I2V_MODEL, duration }];
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

function providerStatus(raw: string): Prediction["status"] {
  if (isWaveSpeedSuccess(raw) || raw === "succeeded") return "succeeded";
  if (raw === "cancelled" || raw === "canceled") return "canceled";
  if (isWaveSpeedFailure(raw)) return "failed";
  if (raw === "processing") return "processing";
  return "starting";
}

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

function toPrediction(id: string, payload: unknown): Prediction {
  const data = waveSpeedData(payload);
  const status = providerStatus(waveSpeedStatus(payload));
  const createdAt = typeof data.created_at === "string" ? data.created_at : null;
  const errorText = waveSpeedErrorText(payload);
  const error = errorText ? redactSecrets(errorText) : null;
  return {
    id: waveSpeedId(payload) ?? id,
    status,
    output: data.outputs,
    error,
    logs: typeof data.logs === "string" ? data.logs : null,
    created_at: createdAt,
    started_at: typeof data.started_at === "string" ? data.started_at : createdAt,
    completed_at: typeof data.completed_at === "string" ? data.completed_at : null,
  };
}

async function responseDetail(response: Response): Promise<{ text: string; json: unknown | null }> {
  const text = await response.text().catch(() => "");
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: null };
  }
}

function rejected(status: number, message: string, body: string): VisualEngineError {
  const detail = redactSecrets(message || body).slice(0, 600);
  return new VisualEngineError(
    status === 402
      ? `The render provider refused the job: payment required / out of credits [402]${
          detail ? ` — ${detail}` : ""
        }`
      : `Render rejected [${status}]${detail ? ` — ${detail}` : ""}`,
    status,
    detail,
  );
}

async function submitModel(
  model: string,
  body: Record<string, unknown>,
  label = `motion dispatch (${model})`,
): Promise<Prediction> {
  if (model === HAILUO_I2V_MODEL) {
    assertHailuoDuration(Number(body.duration));
  }
  const url = waveSpeedModelUrl(model);
  let response: Response;
  try {
    response = await resilientFetch(
      url,
      { method: "POST", headers: credentials(), body: JSON.stringify(body) },
      { label, timeoutMs: 180_000, retries: 0, useBreaker: false },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VisualEngineError(
      `Render dispatch could not reach the engine — ${reason}`,
      null,
      reason,
    );
  }
  const parsed = await responseDetail(response);
  if (!response.ok) {
    throw rejected(response.status, waveSpeedErrorText(parsed.json) ?? "", parsed.text);
  }
  const code =
    parsed.json && typeof parsed.json === "object" && !Array.isArray(parsed.json)
      ? (parsed.json as Record<string, unknown>).code
      : undefined;
  if (typeof code === "number" && code !== 200) {
    throw rejected(code, waveSpeedErrorText(parsed.json) ?? "", parsed.text);
  }
  const id = waveSpeedId(parsed.json);
  if (!id) {
    throw new VisualEngineError(
      "The visual engine returned no job id.",
      response.status,
      redactSecrets(parsed.text).slice(0, 600),
    );
  }
  return toPrediction(id, parsed.json);
}

export async function readPrediction(id: string): Promise<Prediction> {
  let response: Response;
  try {
    response = await resilientFetch(
      waveSpeedResultUrl(id),
      { headers: credentials() },
      {
        label: `render poll (${id})`,
        timeoutMs: 45_000,
        retries: 0,
        baseDelayMs: 1000,
        useBreaker: false,
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VisualEngineError(`Render job could not be read — ${reason}`, null, reason);
  }
  const parsed = await responseDetail(response);
  if (!response.ok) {
    throw new VisualEngineError(
      `Render job could not be read [${response.status}].`,
      response.status,
      redactSecrets(parsed.text).slice(0, 400),
    );
  }
  return toPrediction(id, parsed.json);
}

/** WaveSpeed returns the media URL on `data.outputs[0]`. */
export function firstOutputUrl(output: unknown): string | null {
  if (typeof output === "string" && output.trim()) return output;
  if (Array.isArray(output)) {
    const hit = output.find((entry) => typeof entry === "string" && entry.trim());
    return typeof hit === "string" ? hit : null;
  }
  return null;
}

async function waitForOutput(id: string, timeoutMs: number, label: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    const prediction = await readPrediction(id);
    if (prediction.status === "succeeded") {
      const url =
        waveSpeedOutputUrl({ outputs: prediction.output }) ?? firstOutputUrl(prediction.output);
      if (!url) {
        throw new VisualEngineError(`The ${label} finished without data.outputs[0].`, null, "");
      }
      return url;
    }
    if (prediction.status === "failed" || prediction.status === "canceled") {
      throw new VisualEngineError(
        prediction.error || `The ${label} failed.`,
        null,
        prediction.error ?? "",
      );
    }
    if (Date.now() - started > timeoutMs) {
      throw new VisualEngineError(`The ${label} timed out.`, null, "");
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}

function promptWithNegatives(prompt: string, limit: number): string {
  const safe = clampResolutionLanguage(prompt).trim();
  const combined = safe.includes("triptych") ? safe : `${safe} Avoid: ${GLOBAL_NEGATIVE_PROMPT}.`;
  return combined.slice(0, limit);
}

/**
 * Stage 1 — scene keyframe on flux-dev.
 *
 * The confirmed schema is text-to-image (`prompt`, `size`, `output_format`,
 * `num_inference_steps`). Character sheets are not posted: flux-dev's `image`
 * field is an img2img source, and this pipeline must not redraw the sheet.
 */
export async function createFoundationFrame(
  prompt: string,
  _identityReferences?: string[] | undefined,
): Promise<string> {
  const started = await submitModel(
    FLUX_DEV_MODEL,
    {
      prompt: promptWithNegatives(prompt, 1800),
      size: FLUX_DEV_SIZE_16_9,
      output_format: "png",
      num_inference_steps: 28,
    },
    `keyframe dispatch (${FLUX_DEV_MODEL})`,
  );
  return waitForOutput(started.id, 180_000, "keyframe engine");
}

export type MotionJob = { id: string; status: string; progress: number; engine: MotionEngineId };

function assertStartImage(image: string | undefined): string {
  const value = image?.trim() ?? "";
  if (!/^(https?:|data:image\/)/i.test(value)) {
    throw new VisualEngineError(
      "WaveSpeed image-to-video requires a start image URL.",
      400,
      "image",
    );
  }
  return value;
}

function motionBody(
  model: string,
  prompt: string,
  duration: number,
  image: string,
): Record<string, unknown> {
  if (model === HAILUO_I2V_MODEL) {
    return { image, prompt, duration: assertHailuoDuration(duration) };
  }
  if (model === SEEDANCE_I2V_MODEL) {
    return {
      image,
      prompt,
      duration,
      resolution: NATIVE_RENDER_RESOLUTION,
      generate_audio: false,
    };
  }
  throw new VisualEngineError(`No confirmed WaveSpeed motion model for ${model}.`, 400, model);
}

/**
 * Dispatches one cinematic motion block from a 16:9 keyframe.
 *
 * `styleReferences` and `audioReference` are not WaveSpeed motion fields.
 * Seedance `generate_audio` is forced off so the clip stays picture-only;
 * the studio muxes the uploaded track.
 */
export async function createMotionBlock(input: {
  prompt: string;
  seconds: number;
  referenceImage?: string | undefined;
  styleReferences?: string[] | undefined;
  audioReference?: string | undefined;
  shotClass?: ShotClass | undefined;
}): Promise<MotionJob> {
  const prompt = promptWithNegatives(input.prompt, 4000);
  const image = assertStartImage(input.referenceImage);
  const chain = resolveCinematicMotion(input.seconds);
  let lastError: VisualEngineError | null = null;

  const health = chain.map((engine) => ({ engine, skip: breakerOpen(engine.model) }));
  const healthy = health.filter((h) => !h.skip).map((h) => h.engine);
  const usable = healthy.length > 0 ? healthy : chain;

  for (const engine of usable) {
    const payload = motionBody(engine.model, prompt, engine.duration, image);
    try {
      const prediction = await submitModel(engine.model, payload);
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
      if (failure.status === 402) throw failure;
    }
  }

  throw lastError ?? new VisualEngineError("No visual engine is available right now.", null, "");
}

/**
 * WaveSpeed has no cancel for an in-flight prediction. `POST /predictions/delete`
 * only removes finished tasks and does not stop a created or processing job,
 * so this does not call it and does not call Replicate.
 */
export async function cancelPrediction(id: string): Promise<boolean> {
  console.error(
    `[visual] WaveSpeed cannot cancel in-flight prediction ${id}. Finished-task delete was not called.`,
  );
  return false;
}
