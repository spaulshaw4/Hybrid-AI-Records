/**
 * Gate 6 — Replicate Matchering 2.0 (`jimothyjohn/matchering`).
 *
 * Requires public HTTPS (or Replicate file) URIs for target + reference.
 * Auth is always the hybrid1 `REPLICATE_API_TOKEN` (alias `REPLICATE_API_KEY`).
 */
import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { readEnv, requireStageKey } from "@/lib/env";
import {
  MATCHERING_REPLICATE_TIMEOUT_MS,
  MATCHERING_REFERENCE_RELATIVE,
} from "@/lib/matchering";
import {
  communityPredictionBody,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { isHttpAudioUrl } from "@/lib/pipeline-contracts";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const MATCHERING_MODEL =
  process.env["MATCHERING_REPLICATE_MODEL"]?.trim() || "jimothyjohn/matchering";

const POLL_MAX_ATTEMPTS = 48; // 48 × 2.5s ≈ 120s
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
    requireStageKey("REPLICATE_API_TOKEN", "Matchering Mastering");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function bail(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error(
      "Matchering has insufficient Replicate credit. Top up hybrid1 billing and retry.",
    );
  }
  console.error(`[matchering-replicate] ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
  throw new Error(`Matchering ${what} failed [${response.status}].`);
}

function assertReachableAudioUri(url: string, label: string): string {
  const trimmed = url.trim();
  if (!isHttpAudioUrl(trimmed)) {
    throw new Error(`Matchering ${label} must be a public HTTPS URL (got local/invalid URI).`);
  }
  if (/localhost|127\.0\.0\.1|\/api\/local-vault\//i.test(trimmed)) {
    throw new Error(`Matchering refused localhost / local-vault ${label} URL.`);
  }
  return trimmed;
}

/** Upload bytes to Replicate Files so the model can fetch them. */
async function uploadReplicateAudio(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<string> {
  const form = new FormData();
  form.append("content", new Blob([bytes.slice().buffer], { type: mime }), filename);
  const headers = credentials();
  delete (headers as { "Content-Type"?: string })["Content-Type"];
  const response = await resilientFetch(
    `${replicateBaseUrl()}/files`,
    { method: "POST", headers, body: form },
    { label: "matchering audio upload", timeoutMs: 120_000, retries: 0 },
  );
  if (!response.ok) await bail(response, "audio upload");
  const payload = (await response.json()) as { urls?: { get?: string } };
  const url = payload.urls?.get;
  if (!url) throw new Error("Matchering upload returned no audio URL.");
  return url;
}

async function latestVersion(): Promise<string> {
  const response = await resilientFetch(
    `${replicateBaseUrl()}/models/${MATCHERING_MODEL}`,
    { headers: credentials() },
    { label: "matchering model lookup", timeoutMs: 30_000, retries: 0 },
  );
  if (!response.ok) await bail(response, "model lookup");
  const payload = (await response.json()) as { latest_version?: { id?: string } };
  const id = payload.latest_version?.id;
  if (!id) throw new Error("The Matchering model is unavailable on this account.");
  return id;
}

function pickMasterUrl(output: unknown): string | null {
  if (typeof output === "string" && output.startsWith("http")) return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      if (typeof item === "string" && item.startsWith("http")) return item;
    }
  }
  if (output && typeof output === "object") {
    const map = output as Record<string, unknown>;
    for (const key of ["audio", "output", "wav", "mp3", "file", "url"]) {
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
    { label: "matchering cancel", timeoutMs: 15_000, retries: 0 },
  ).catch(() => undefined);
}

/**
 * Resolve a reachable reference URI: env URL, then local reference file uploaded
 * to Replicate Files. Returns null when neither is available.
 */
export async function resolveMatcheringReferenceUri(
  cwd: string = process.cwd(),
): Promise<string | null> {
  const fromEnv =
    readEnv("MATCHERING_REFERENCE_URL") ||
    readEnv("MATCHERING_REFERENCE_HTTPS_URL");
  if (fromEnv) {
    try {
      return assertReachableAudioUri(fromEnv, "reference");
    } catch (error) {
      console.warn(
        "[matchering-replicate] MATCHERING_REFERENCE_URL invalid",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const localPath =
    readEnv("MATCHERING_REFERENCE_PATH") || join(cwd, MATCHERING_REFERENCE_RELATIVE);
  try {
    await access(localPath);
    const bytes = new Uint8Array(await readFile(localPath));
    if (bytes.byteLength < 1024) return null;
    const mime = localPath.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
    const uploaded = await uploadReplicateAudio(
      bytes,
      localPath.toLowerCase().endsWith(".mp3") ? "reference.mp3" : "reference.wav",
      mime,
    );
    return assertReachableAudioUri(uploaded, "reference");
  } catch {
    return null;
  }
}

/**
 * Run Matchering on Replicate. `targetUrl` must already be a public HTTPS /
 * Replicate Files URL (never a local disk path).
 */
export async function runReplicateMatchering(input: {
  targetUrl: string;
  referenceUrl: string;
}): Promise<string> {
  const target = assertReachableAudioUri(input.targetUrl, "target");
  const reference = assertReachableAudioUri(input.referenceUrl, "reference");

  console.log(
    `[GATE_6_MATCHERING] auth=REPLICATE_API_TOKEN|REPLICATE_API_KEY (hybrid1), model=${MATCHERING_MODEL}, cancelAfter=${MATCHERING_REPLICATE_TIMEOUT_MS / 1000}s`,
  );

  const version = await latestVersion();
  const body = communityPredictionBody(version, { target, reference });
  const created = await resilientFetch(
    `${replicateBaseUrl()}/predictions`,
    {
      method: "POST",
      headers: { ...credentials(), ...replicateRunHeaders(MATCHERING_REPLICATE_TIMEOUT_MS) },
      body: JSON.stringify(body),
    },
    { label: "matchering dispatch", breakerKey: "mastering:matchering", timeoutMs: 60_000, retries: 0 },
  );
  if (!created.ok) await bail(created, "dispatch");

  const initial = (await created.json()) as PredictionState;
  const id = initial.id;
  if (!id) throw new Error("Matchering returned no prediction id.");

  const { pollWithBreaker, isTerminalPollStatus } = await import(
    "@/lib/poll-with-breaker.server"
  );

  let useInitial = true;
  try {
    const masterUrl = await pollWithBreaker<string | null>(
      async () => {
        let prediction: PredictionState;
        if (useInitial) {
          useInitial = false;
          prediction = initial;
        } else {
          const poll = await resilientFetch(
            `${replicateBaseUrl()}/predictions/${id}`,
            { headers: credentials() },
            { label: "matchering poll", timeoutMs: 20_000, retries: 0, baseDelayMs: 1000 },
          );
          if (!poll.ok) {
            throw new Error(`[Polling Gate 6 Matchering] HTTP ${poll.status} — aborting poll.`);
          }
          prediction = (await poll.json()) as PredictionState;
        }

        if (prediction.status === "succeeded") {
          const url = pickMasterUrl(prediction.output);
          if (!url) {
            throw new Error("Matchering succeeded but returned an empty audio URL.");
          }
          return assertReachableAudioUri(url, "output");
        }
        if (isTerminalPollStatus(prediction.status)) {
          throw new Error(String(prediction.error ?? "Matchering prediction failed."));
        }
        return null;
      },
      (url) => url !== null,
      () => false,
      {
        maxAttempts: POLL_MAX_ATTEMPTS,
        intervalMs: POLL_INTERVAL_MS,
        stepName: "Gate 6 Matchering",
      },
    );
    return masterUrl!;
  } catch (error) {
    await cancelPrediction(id).catch(() => undefined);
    throw error;
  }
}

/**
 * Upload premaster bytes to Supabase vault, then Matchering on Replicate.
 * Returns the Replicate output URL (still needs local finish / vault re-upload).
 */
export async function matcheringFromPremasterBytes(input: {
  premasterWav: Uint8Array;
  userId: string;
  taskId: string;
  referenceUrl?: string | null;
}): Promise<string | null> {
  if (!input.premasterWav.byteLength || input.premasterWav.byteLength < 1024) {
    throw new Error("Matchering premaster buffer was empty.");
  }

  const referenceUrl =
    (input.referenceUrl && assertReachableAudioUri(input.referenceUrl, "reference")) ||
    (await resolveMatcheringReferenceUri());
  if (!referenceUrl) {
    console.warn(
      "[matchering-replicate] no MATCHERING_REFERENCE_URL / local reference — skipping Replicate Matchering",
    );
    return null;
  }

  const premasterPath = `premasters/${input.userId}/${input.taskId}_premaster.wav`;
  const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
  const targetUrl = assertReachableAudioUri(
    await uploadEngineMaster(input.premasterWav, premasterPath, "wav"),
    "premaster",
  );
  console.log("[GATE_6_MATCHERING] premaster uploaded for Replicate", premasterPath);

  return runReplicateMatchering({ targetUrl, referenceUrl });
}
