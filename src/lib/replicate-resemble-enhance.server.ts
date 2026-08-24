/**
 * Gate 6 — Replicate Resemble Enhance (`resemble-ai/resemble-enhance`).
 *
 * Spectral enhancement / super-resolution on the premaster mix.
 * Auth: hybrid1 `REPLICATE_API_TOKEN` (alias `REPLICATE_API_KEY`).
 * Version is pinned so Gate 6 never floats to an unexpected schema.
 */
import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { requireStageKey } from "@/lib/env";
import {
  communityPredictionBody,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { isHttpAudioUrl } from "@/lib/pipeline-contracts";

/** Pinned Cog version — spectral enhance for Gate 6 finalize. */
export const RESEMBLE_ENHANCE_VERSION =
  "93266a7e7f5805fb79bcf213b1a4e0ef2e45aff3c06eefd96c59e850c87fd6a2";

export const RESEMBLE_ENHANCE_MODEL = "resemble-ai/resemble-enhance";

/** Faster CFM solver + fewer NFEs to keep Gate 6 under the poll budget. */
export const RESEMBLE_ENHANCE_SOLVER = "Euler";
export const RESEMBLE_ENHANCE_NFE = 20;
export const RESEMBLE_ENHANCE_DENOISE = false;

/** Cancel-After + poll budget (~47s typical; allow GPU cold-start). */
export const RESEMBLE_ENHANCE_TIMEOUT_MS = 180_000;

const POLL_MAX_ATTEMPTS = 72; // 72 × 2.5s = 180s
const POLL_INTERVAL_MS = 2_500;

type PredictionState = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
};

function credentials() {
  const token =
    (typeof process !== "undefined" && process.env.REPLICATE_API_TOKEN?.trim()) ||
    (typeof process !== "undefined" && process.env.REPLICATE_API_KEY?.trim()) ||
    requireStageKey("REPLICATE_API_TOKEN", "Resemble Enhance");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function bail(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error(
      "Resemble Enhance has insufficient Replicate credit. Top up hybrid1 billing and retry.",
    );
  }
  console.error(
    `[resemble-enhance] ${what} failed [${response.status}]: ${body.slice(0, 400)}`,
  );
  throw new Error(`Resemble Enhance ${what} failed [${response.status}].`);
}

function assertReachableAudioUri(url: string, label: string): string {
  const trimmed = url.trim();
  if (!isHttpAudioUrl(trimmed)) {
    throw new Error(
      `Resemble Enhance ${label} must be a public HTTPS URL (got local/invalid URI).`,
    );
  }
  if (/localhost|127\.0\.0\.1|\/api\/local-vault\//i.test(trimmed)) {
    throw new Error(`Resemble Enhance refused localhost / local-vault ${label} URL.`);
  }
  return trimmed;
}

/**
 * Resemble Enhance outputs `[denoised_url, enhanced_url]`.
 * Prefer enhanced (`output[1]`), fall back to denoised (`output[0]`).
 */
export function pickEnhancedAudioUrl(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("http")) return output;
  if (Array.isArray(output)) {
    const urls = output.filter(
      (item): item is string => typeof item === "string" && item.startsWith("http"),
    );
    // Matches: const finalMasterUrl = output[1] || output[0]
    return urls[1] || urls[0] || null;
  }
  if (output && typeof output === "object") {
    const map = output as Record<string, unknown>;
    for (const key of ["enhanced", "audio", "output", "wav", "mp3", "file", "url"]) {
      const value = map[key];
      if (typeof value === "string" && value.startsWith("http")) return value;
      if (Array.isArray(value)) {
        const nested = pickEnhancedAudioUrl(value);
        if (nested) return nested;
      }
    }
  }
  return null;
}

async function cancelPrediction(id: string): Promise<void> {
  await resilientFetch(
    `${replicateBaseUrl()}/predictions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", headers: credentials() },
    { label: "resemble-enhance cancel", timeoutMs: 15_000, retries: 0 },
  ).catch(() => undefined);
}

/**
 * Run Resemble Enhance on a public HTTPS / Replicate Files audio URL.
 * Never pass local disk paths — Replicate cannot reach them.
 */
export async function runResembleEnhance(input: {
  audioUrl: string;
  /** Override default `denoise_flag: false` when needed. */
  denoise?: boolean;
}): Promise<string> {
  const audioUrl = assertReachableAudioUri(input.audioUrl, "input_audio");
  const denoiseFlag = input.denoise ?? RESEMBLE_ENHANCE_DENOISE;

  console.log(
    `[GATE_6_RESEMBLE_ENHANCE] auth=REPLICATE_API_TOKEN|REPLICATE_API_KEY (hybrid1), model=${RESEMBLE_ENHANCE_MODEL}, version=${RESEMBLE_ENHANCE_VERSION.slice(0, 12)}…, solver=${RESEMBLE_ENHANCE_SOLVER}, nfe=${RESEMBLE_ENHANCE_NFE}, denoise=${denoiseFlag}, cancelAfter=${RESEMBLE_ENHANCE_TIMEOUT_MS / 1000}s`,
  );

  const body = communityPredictionBody(RESEMBLE_ENHANCE_VERSION, {
    input_audio: audioUrl,
    solver: RESEMBLE_ENHANCE_SOLVER,
    number_function_evaluations: RESEMBLE_ENHANCE_NFE,
    denoise_flag: denoiseFlag,
  });

  const created = await resilientFetch(
    `${replicateBaseUrl()}/predictions`,
    {
      method: "POST",
      headers: {
        ...credentials(),
        ...replicateRunHeaders(RESEMBLE_ENHANCE_TIMEOUT_MS),
      },
      body: JSON.stringify(body),
    },
    {
      label: "resemble-enhance dispatch",
      breakerKey: "mastering:resemble-enhance",
      timeoutMs: 60_000,
      retries: 0,
    },
  );
  if (!created.ok) await bail(created, "dispatch");

  const initial = (await created.json()) as PredictionState;
  const id = initial.id;
  if (!id) throw new Error("Resemble Enhance returned no prediction id.");

  const { pollWithBreaker, isTerminalPollStatus } = await import(
    "@/lib/poll-with-breaker.server"
  );

  let useInitial = true;
  try {
    const enhancedUrl = await pollWithBreaker<string | null>(
      async () => {
        let prediction: PredictionState;
        if (useInitial) {
          useInitial = false;
          prediction = initial;
        } else {
          const poll = await resilientFetch(
            `${replicateBaseUrl()}/predictions/${id}`,
            { headers: credentials() },
            {
              label: "resemble-enhance poll",
              timeoutMs: 20_000,
              retries: 0,
              baseDelayMs: 1000,
            },
          );
          if (!poll.ok) {
            throw new Error(
              `[Polling Gate 6 Resemble Enhance] HTTP ${poll.status} — aborting poll.`,
            );
          }
          prediction = (await poll.json()) as PredictionState;
        }

        if (prediction.status === "succeeded") {
          const url = pickEnhancedAudioUrl(prediction.output);
          if (!url) {
            throw new Error("Resemble Enhance succeeded but returned an empty audio URL.");
          }
          return assertReachableAudioUri(url, "output");
        }
        if (isTerminalPollStatus(prediction.status)) {
          throw new Error(String(prediction.error ?? "Resemble Enhance prediction failed."));
        }
        return null;
      },
      (url) => url !== null,
      () => false,
      {
        maxAttempts: POLL_MAX_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        stepName: "Gate 6 Resemble Enhance",
      },
    );
    return enhancedUrl!;
  } catch (error) {
    await cancelPrediction(id).catch(() => undefined);
    throw error;
  }
}

/**
 * Upload local premaster bytes to Supabase, then Resemble Enhance on Replicate.
 * Returns the enhanced HTTPS URL for Gate 6 finish / player handoff.
 */
export async function enhancePremasterBytes(input: {
  premasterWav: Uint8Array;
  userId: string;
  taskId: string;
  denoise?: boolean;
}): Promise<string> {
  if (!input.premasterWav.byteLength || input.premasterWav.byteLength < 1024) {
    throw new Error("Resemble Enhance premaster buffer was empty.");
  }

  const premasterPath = `premasters/${input.userId}/${input.taskId}_enhance_in.wav`;
  const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
  const audioUrl = assertReachableAudioUri(
    await uploadEngineMaster(input.premasterWav, premasterPath, "wav"),
    "premaster",
  );
  console.log("[GATE_6_RESEMBLE_ENHANCE] premaster uploaded for Replicate", premasterPath);

  return runResembleEnhance({ audioUrl, denoise: input.denoise });
}
