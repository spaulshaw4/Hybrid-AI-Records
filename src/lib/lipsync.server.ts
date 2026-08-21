import { replicateBaseUrl, replicateHeaders } from "@/lib/ai-provider.server";
/**
 * Selective lip-sync stage (server only).
 *
 * Shots the planner tagged `vocalSync` — a performer visibly singing the lead
 * vocal — are re-rendered through the `sync/lipsync-2` model with the exact
 * audio slice that plays under that shot. Every other shot skips this stage
 * entirely and keeps its raw cinematic diffusion clip.
 */

import { resilientFetch } from "@/lib/resilient-fetch.server";


/**
 * Audio-driven portrait sync models, tried in order. The first is the primary
 * LivePortrait-class engine; the rest are drop-in fallbacks if a model is
 * unavailable on the account.
 */
const LIPSYNC_MODELS = [
  process.env["LIPSYNC_MODEL"] || "sync/lipsync-2",
  "bytedance/latentsync",
  "cjwbw/sadtalker",
] as const;

function credentials() {
  return replicateHeaders("The lip-sync engine");
}

async function failure(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error("The lip-sync engine has no render credit left. Top it up and retry this shot.");
  }
  console.error(`Lip-sync ${what} failed [${response.status}]: ${body}`);
  throw new Error(`Lip-sync ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
}

/** Uploads the sliced audio segment and returns a URL the model can read. */
async function uploadAudioSlice(bytes: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.append("content", new Blob([bytes.slice().buffer], { type: "audio/wav" }), filename);

  const response = await resilientFetch(
    `${replicateBaseUrl()}/files`,
    { method: "POST", headers: credentials(), body: form },
    { label: "lip-sync audio upload", timeoutMs: 120_000, retries: 0 },
  );
  if (!response.ok) await failure(response, "audio upload");
  const payload = (await response.json()) as { urls?: { get?: string } };
  const url = payload.urls?.get;
  if (!url) throw new Error("The lip-sync engine returned no audio URL.");
  return url;
}

/**
 * Runs `sync/lipsync-2` on one shot and returns the synced clip URL.
 * `audioWav` is the slice of the master track covering exactly this shot.
 */
export async function lipsyncShot(input: {
  videoUrl: string;
  audioWav: Uint8Array;
  shotIndex: number;
}): Promise<string> {
  const audioUrl = await uploadAudioSlice(
    input.audioWav,
    `shot_${String(input.shotIndex + 1).padStart(2, "0")}_audio.wav`,
  );

  let created: Response | null = null;
  for (const model of LIPSYNC_MODELS) {
    let attempt: Response;
    try {
      attempt = await resilientFetch(
        `${replicateBaseUrl()}/models/${model}/predictions`,
        {
          method: "POST",
          headers: { ...credentials(), "Content-Type": "application/json" },
          body: JSON.stringify({ input: { video: input.videoUrl, audio: audioUrl } }),
        },
        { label: `lip-sync dispatch (${model})`, breakerKey: `lipsync:${model}`, timeoutMs: 180_000, retries: 0 },
      );
    } catch (error) {
      // Transport failure or breaker open — try the next model rather than
      // taking the render queue down.
      console.error(`Lip-sync dispatch unreachable on ${model}:`, error);
      continue;
    }
    if (attempt.ok) {
      created = attempt;
      break;
    }
    // 404 = model not available on this account; anything else is fatal.
    if (attempt.status !== 404) await failure(attempt, "dispatch");
    console.warn(`Lip-sync model ${model} unavailable, trying the next one.`);
  }
  if (!created) throw new Error("No lip-sync model is available on this account.");

  const prediction = (await created.json()) as { id?: string };
  const id = prediction.id;
  if (!id) throw new Error("The lip-sync engine returned no job id.");

  // Lip-sync on a 4–8s block usually lands well inside 3 minutes.
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 3000 : 5000));
    const poll = await resilientFetch(
      `${replicateBaseUrl()}/predictions/${id}`,
      { headers: credentials() },
      { label: "lip-sync poll", timeoutMs: 45_000, retries: 0, baseDelayMs: 1000 },
    );
    if (!poll.ok) await failure(poll, "poll");
    const state = (await poll.json()) as {
      status?: string;
      output?: unknown;
      error?: unknown;
    };
    if (state.status === "succeeded") {
      const output = Array.isArray(state.output) ? state.output[0] : state.output;
      if (typeof output === "string" && output.startsWith("http")) return output;
      throw new Error("The lip-sync engine returned no clip.");
    }
    if (state.status === "failed" || state.status === "canceled") {
      throw new Error(String(state.error ?? "The lip-sync pass failed for this shot."));
    }
  }
  throw new Error("The lip-sync pass timed out for this shot.");
}
