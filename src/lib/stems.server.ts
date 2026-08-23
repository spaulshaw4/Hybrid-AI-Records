/**
 * Audio stem separation worker (server only).
 *
 * When a master track is ingested the studio spins this worker up in the
 * background: Demucs splits the song into an isolated VOCAL stem and a
 * rhythmic (drum) stem.
 *
 *  - the vocal stem feeds the lip-sync module (Wav2Lip / SadTalker / lipsync-2)
 *    for every shot flagged `vocalSync: true`, so the mouth tracks the lead
 *    vocal instead of the full mix;
 *  - the rhythmic stem drives downbeat detection so scene cuts land on the
 *    track's real bar grid.
 *
 * Predictions request T4 GPU when the API accepts a hardware SKU, and always
 * carry a 120s Cancel-After deadline so a stalled worker cannot bill GPU time.
 */

import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { requireStageKey } from "@/lib/env";
import {
  communityPredictionBody,
  REPLICATE_PREDICTION_TIMEOUT_MS,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";
import { parseDemucsOutput, backingStemUrl, type DemucsStemUrls } from "@/lib/stem-urls";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";
import {
  assertPipelineBreakerClosed,
  recordPipelineFailure,
  recordPipelineHttp,
  recordPipelineSuccess,
} from "@/lib/pipeline-breaker";
import {
  isHttpAudioUrl,
  logPostConditionPassed,
  logPreConditionPassed,
  throwFailEarly,
} from "@/lib/pipeline-contracts";
import { assertDemucsStemUrlGate } from "@/lib/studio-pipeline-gates";
import { logFailedStudioGate } from "@/lib/studio-pipeline-error";

const DEMUCS_MODEL = process.env["DEMUCS_MODEL"] || "ryan5453/demucs";
/** Only a private deployment can pin hardware; a public model 422s on it. */
const DEMUCS_HARDWARE = process.env["DEMUCS_HARDWARE"]?.trim();
const DEMUCS_DEPLOYMENT = process.env["DEMUCS_DEPLOYMENT"]?.trim();

export type StemResult = DemucsStemUrls;

type PredictionState = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
};

function credentials() {
  const token =
    (typeof process !== "undefined" && process.env.REPLICATE_API_KEY?.trim()) ||
    requireStageKey("REPLICATE_API_KEY", "Stem Separation");
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}

async function bail(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error("The stem worker has no render credit left. Top it up and retry.");
  }
  console.error(`Stem worker ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
  recordPipelineHttp("stems", response.status);
  logPipelineStepError("stems", new Error(`Stem separation ${what} failed`), {
    status: response.status,
    body,
  });
  throw new Error(`Stem separation ${what} failed [${response.status}].`);
}

/** Uploads the master track so the separation model can read it. */
async function uploadTrack(bytes: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.append("content", new Blob([bytes.slice().buffer], { type: "audio/mpeg" }), filename);
  const headers = credentials();
  delete (headers as { "Content-Type"?: string })["Content-Type"];
  const response = await resilientFetch(
    `${replicateBaseUrl()}/files`,
    { method: "POST", headers, body: form },
    { label: "stem audio upload", timeoutMs: 120_000, retries: 0 },
  );
  if (!response.ok) await bail(response, "audio upload");
  const payload = (await response.json()) as { urls?: { get?: string } };
  const url = payload.urls?.get;
  if (!url) throw new Error("The stem worker returned no audio URL.");
  return url;
}

/** Resolves the current Demucs version hash (community model endpoint). */
async function latestVersion(): Promise<string> {
  const response = await resilientFetch(
    `${replicateBaseUrl()}/models/${DEMUCS_MODEL}`,
    { headers: credentials() },
    { label: "demucs model lookup", timeoutMs: 30_000, retries: 0 },
  );
  if (!response.ok) await bail(response, "model lookup");
  const payload = (await response.json()) as { latest_version?: { id?: string } };
  const id = payload.latest_version?.id;
  if (!id) throw new Error("The stem separation model is unavailable on this account.");
  return id;
}

function pickStems(output: unknown): StemResult {
  console.log("[GATE_3_DEMUCS_OUTPUT]:", JSON.stringify(output, null, 2));
  const stems = parseDemucsOutput(output);
  if (!stems.vocals) {
    console.warn("[GATE_3_DEMUCS_OUTPUT] no vocal stem in output shape:", typeof output);
  }
  return stems;
}

async function cancelPrediction(id: string): Promise<void> {
  await resilientFetch(
    `${replicateBaseUrl()}/predictions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", headers: credentials() },
    { label: "stem separation cancel", timeoutMs: 15_000, retries: 0 },
  ).catch(() => undefined);
}

function isTerminalFailure(status: string | undefined): boolean {
  return status === "failed" || status === "canceled" || status === "aborted";
}

/**
 * Runs one separation pass. Returns the isolated vocal + rhythmic stem URLs.
 * Never throws for a missing stem — the caller degrades to the full mix.
 */
export async function separateStems(input: {
  audio: Uint8Array;
  filename: string;
}): Promise<StemResult> {
  assertPipelineBreakerClosed("stems");
  if (!input.audio?.byteLength || input.audio.byteLength < 1024) {
    throwFailEarly("stems", "source audio buffer was empty");
  }
  logPreConditionPassed("stems", "source audio buffer valid");
  logPipelineStep("stems");

  const finish = (stems: StemResult): StemResult => {
    recordPipelineSuccess("stems");
    if (isHttpAudioUrl(stems.vocals) && isHttpAudioUrl(backingStemUrl(stems))) {
      assertDemucsStemUrlGate(stems, { required: true });
      logPostConditionPassed("Stems ready for Vocal Synthesis");
    }
    return stems;
  };

  try {
    const audioUrl = await uploadTrack(input.audio, input.filename);
    const inputPayload = { audio: audioUrl, output_format: "mp3" };

    const createUrl = DEMUCS_DEPLOYMENT
      ? `${replicateBaseUrl()}/deployments/${DEMUCS_DEPLOYMENT}/predictions`
      : `${replicateBaseUrl()}/predictions`;
    const version = DEMUCS_DEPLOYMENT ? null : await latestVersion();
    // A public model rejects a hardware SKU with 422, so only a private
    // deployment's own hardware applies. Sending it cost a wasted round trip.
    const body = DEMUCS_DEPLOYMENT
      ? { input: inputPayload }
      : communityPredictionBody(version!, inputPayload, {
          ...(DEMUCS_HARDWARE ? { hardware: DEMUCS_HARDWARE } : {}),
        });

    const dispatch = (payload: unknown) =>
      resilientFetch(
        createUrl,
        {
          method: "POST",
          headers: { ...credentials(), ...replicateRunHeaders(REPLICATE_PREDICTION_TIMEOUT_MS) },
          body: JSON.stringify(payload),
        },
        { label: "stem separation dispatch", breakerKey: "stems:demucs", timeoutMs: 90_000, retries: 0 },
      );

    const created = await dispatch(body);
    if (!created.ok) await bail(created, "dispatch");

    let prediction = (await created.json()) as PredictionState;
    const id = prediction.id;
    if (!id) throw new Error("The stem worker returned no job id.");

    const deadline = Date.now() + REPLICATE_PREDICTION_TIMEOUT_MS;

    const settle = async (state: PredictionState): Promise<StemResult | null> => {
      if (state.status === "succeeded") return pickStems(state.output);
      if (isTerminalFailure(state.status)) {
        throw new Error(String(state.error ?? "Stem separation failed for this track."));
      }
      return null;
    };

    const immediate = await settle(prediction);
    if (immediate) return finish(immediate);

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const poll = await resilientFetch(
        `${replicateBaseUrl()}/predictions/${id}`,
        { headers: credentials() },
        { label: "stem separation poll", timeoutMs: 20_000, retries: 0, baseDelayMs: 1000 },
      );
      if (!poll.ok) await bail(poll, "poll");
      prediction = (await poll.json()) as PredictionState;
      const done = await settle(prediction);
      if (done) return finish(done);
    }

    await cancelPrediction(id);
    throw new Error("Stem separation timed out for this track.");
  } catch (error) {
    recordPipelineFailure("stems", error);
    logFailedStudioGate(error);
    throw error;
  }
}
