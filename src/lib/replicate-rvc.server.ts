/**
 * Gate 5 — Replicate Realistic Voice Cloning (RVC v2).
 *
 * Converts the isolated Demucs guide vocal into the artist's timbre while
 * preserving melodic pitch (`pitch_change: no-change`, `f0_method: rmvpe`).
 * Auth: hybrid1 `REPLICATE_API_TOKEN` (alias `REPLICATE_API_KEY`).
 */
import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { readEnv, requireStageKey } from "@/lib/env";
import {
  communityPredictionBody,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { isHttpAudioUrl } from "@/lib/pipeline-contracts";
import { logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";

/** Pinned Cog version — melodic pitch-preserving RVC for Gate 5. */
export const RVC_VERSION =
  "0a9c7c558af4c0f20667c1bd12600e5a1ddc443424d84d2d6077896176583e7d";

export const RVC_MODEL = "zsxkib/realistic-voice-cloning";

/** Pitch / timbre defaults — keep melody key, balance user timbre. */
export const RVC_PITCH_CHANGE = "no-change";
export const RVC_INDEX_RATE = 0.5;
export const RVC_FILTER_RADIUS = 3;
export const RVC_PROTECT = 0.33;
export const RVC_F0_METHOD = "rmvpe";
export const RVC_MODEL_NAME = "CUSTOM";

/** Cancel-After + poll — RVC often needs several minutes on T4. */
export const RVC_PREDICTION_TIMEOUT_MS = 300_000;

const POLL_MAX_ATTEMPTS = 120; // 120 × 2.5s = 300s
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
    requireStageKey("REPLICATE_API_TOKEN", "RVC Voice Conversion");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function bail(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error(
      "RVC voice conversion has insufficient Replicate credit. Top up hybrid1 billing and retry.",
    );
  }
  console.error(`[rvc] ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
  logPipelineStepError("vocals", new Error(`RVC ${what} failed`), {
    status: response.status,
    body,
  });
  throw new Error(`RVC ${what} failed [${response.status}].`);
}

function assertReachableUri(url: string, label: string): string {
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://") && !trimmed.startsWith("http://")) {
    throw new Error(`RVC ${label} must be a reachable HTTP(S) URL (got local/invalid URI).`);
  }
  if (/localhost|127\.0\.0\.1|\/api\/local-vault\//i.test(trimmed)) {
    throw new Error(`RVC refused localhost / local-vault ${label} URL.`);
  }
  return trimmed;
}

/** Env fallback when the studio does not send `rvcModelUrl`. */
export function resolveRvcModelDownloadUrl(explicit?: string | null): string | null {
  const fromInput = explicit?.trim();
  if (fromInput) return fromInput;
  return (
    readEnv("RVC_MODEL_DOWNLOAD_URL") ||
    readEnv("CUSTOM_RVC_MODEL_DOWNLOAD_URL") ||
    readEnv("USER_RVC_MODEL_ZIP_URL") ||
    null
  );
}

/**
 * `rvcOutput` is a single URI string (or rarely an array). Prefer the first HTTPS URL.
 */
export function pickRvcVocalUrl(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("http")) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "string" && item.startsWith("http")) return item;
    }
  }
  if (output && typeof output === "object") {
    const map = output as Record<string, unknown>;
    for (const key of ["audio", "output", "vocals", "song", "file", "url"]) {
      const value = map[key];
      if (typeof value === "string" && value.startsWith("http")) return value;
    }
  }
  return null;
}

async function cancelPrediction(id: string): Promise<void> {
  await resilientFetch(
    `${replicateBaseUrl()}/predictions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", headers: credentials() },
    { label: "rvc cancel", timeoutMs: 15_000, retries: 0 },
  ).catch(() => undefined);
}

/**
 * Gate 5 RVC — Demucs guide vocal → artist timbre with melody preserved.
 */
export async function convertVocalsWithRvc(input: {
  /** Isolated Demucs guide vocal (public HTTPS). */
  guideVocalAudioUrl: string;
  /** Artist RVC v2 model zip (public HTTPS / signed URL). */
  customRvcModelDownloadUrl: string;
}): Promise<string> {
  const songInput = assertReachableUri(input.guideVocalAudioUrl, "song_input");
  if (!isHttpAudioUrl(songInput)) {
    throw new Error("RVC song_input must be a public HTTPS audio URL.");
  }
  const modelUrl = assertReachableUri(
    input.customRvcModelDownloadUrl,
    "custom_rvc_model_download_url",
  );

  logPipelineStep("vocals");
  console.log(
    `[GATE_5_RVC] auth=REPLICATE_API_TOKEN|REPLICATE_API_KEY (hybrid1), model=${RVC_MODEL}, version=${RVC_VERSION.slice(0, 12)}…, pitch=${RVC_PITCH_CHANGE}, f0=${RVC_F0_METHOD}, cancelAfter=${RVC_PREDICTION_TIMEOUT_MS / 1000}s`,
  );

  const body = communityPredictionBody(RVC_VERSION, {
    song_input: songInput,
    rvc_model: RVC_MODEL_NAME,
    custom_rvc_model_download_url: modelUrl,
    pitch_change: RVC_PITCH_CHANGE,
    index_rate: RVC_INDEX_RATE,
    filter_radius: RVC_FILTER_RADIUS,
    protect: RVC_PROTECT,
    f0_method: RVC_F0_METHOD,
  });

  const created = await resilientFetch(
    `${replicateBaseUrl()}/predictions`,
    {
      method: "POST",
      headers: { ...credentials(), ...replicateRunHeaders(RVC_PREDICTION_TIMEOUT_MS) },
      body: JSON.stringify(body),
    },
    {
      label: "rvc dispatch",
      breakerKey: "vocals:rvc",
      timeoutMs: 60_000,
      retries: 0,
    },
  );
  if (!created.ok) await bail(created, "dispatch");

  const initial = (await created.json()) as PredictionState;
  const id = initial.id;
  if (!id) throw new Error("RVC returned no prediction id.");

  const { pollWithBreaker, isTerminalPollStatus } = await import(
    "@/lib/poll-with-breaker.server"
  );

  let useInitial = true;
  try {
    const vocalUrl = await pollWithBreaker<string | null>(
      async () => {
        let prediction: PredictionState;
        if (useInitial) {
          useInitial = false;
          prediction = initial;
        } else {
          const poll = await resilientFetch(
            `${replicateBaseUrl()}/predictions/${id}`,
            { headers: credentials() },
            { label: "rvc poll", timeoutMs: 20_000, retries: 0, baseDelayMs: 1000 },
          );
          if (!poll.ok) {
            throw new Error(`[Polling Gate 5 RVC] HTTP ${poll.status} — aborting poll.`);
          }
          prediction = (await poll.json()) as PredictionState;
        }

        if (prediction.status === "succeeded") {
          const url = pickRvcVocalUrl(prediction.output);
          if (!url) {
            throw new Error("RVC succeeded but returned an empty vocal URL.");
          }
          return assertReachableUri(url, "output");
        }
        if (isTerminalPollStatus(prediction.status)) {
          throw new Error(String(prediction.error ?? "RVC prediction failed."));
        }
        return null;
      },
      (url) => url !== null,
      () => false,
      {
        maxAttempts: POLL_MAX_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        stepName: "Gate 5 RVC",
      },
    );
    console.log("[GATE_5_RVC] finished — converted vocal URL ready");
    return vocalUrl!;
  } catch (error) {
    await cancelPrediction(id).catch(() => undefined);
    throw error;
  }
}
