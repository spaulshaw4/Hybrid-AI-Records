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
 */

import { replicateBaseUrl, replicateHeaders } from "@/lib/ai-provider.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";

const DEMUCS_MODEL = process.env["DEMUCS_MODEL"] || "ryan5453/demucs";

export type StemResult = {
  vocals: string | null;
  drums: string | null;
  other: string | null;
};

function credentials() {
  return replicateHeaders("The stem separation worker");
}

async function bail(response: Response, what: string): Promise<never> {
  const body = await response.text();
  if (response.status === 402) {
    throw new Error("The stem worker has no render credit left. Top it up and retry.");
  }
  console.error(`Stem worker ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
  throw new Error(`Stem separation ${what} failed [${response.status}].`);
}

/** Uploads the master track so the separation model can read it. */
async function uploadTrack(bytes: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.append("content", new Blob([bytes.slice().buffer], { type: "audio/mpeg" }), filename);
  const response = await resilientFetch(
    `${replicateBaseUrl()}/files`,
    { method: "POST", headers: credentials(), body: form },
    { label: "stem audio upload", timeoutMs: 180_000, retries: 0 },
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
    { label: "demucs model lookup", timeoutMs: 60_000, retries: 0 },
  );
  if (!response.ok) await bail(response, "model lookup");
  const payload = (await response.json()) as { latest_version?: { id?: string } };
  const id = payload.latest_version?.id;
  if (!id) throw new Error("The stem separation model is unavailable on this account.");
  return id;
}

function pickStems(output: unknown): StemResult {
  const pick = (value: unknown) => (typeof value === "string" && value.startsWith("http") ? value : null);
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const map = output as Record<string, unknown>;
    return {
      vocals: pick(map["vocals"]),
      drums: pick(map["drums"]),
      other: pick(map["other"]) ?? pick(map["bass"]),
    };
  }
  return { vocals: null, drums: null, other: null };
}

/**
 * Runs one separation pass. Returns the isolated vocal + rhythmic stem URLs.
 * Never throws for a missing stem — the caller degrades to the full mix.
 */
export async function separateStems(input: {
  audio: Uint8Array;
  filename: string;
}): Promise<StemResult> {
  const audioUrl = await uploadTrack(input.audio, input.filename);
  const version = await latestVersion();

  const created = await resilientFetch(
    `${replicateBaseUrl()}/predictions`,
    {
      method: "POST",
      headers: { ...credentials(), "Content-Type": "application/json" },
      body: JSON.stringify({
        version,
        input: { audio: audioUrl, stem: "vocals", output_format: "mp3" },
      }),
    },
    { label: "stem separation dispatch", breakerKey: "stems:demucs", timeoutMs: 120_000, retries: 0 },
  );
  if (!created.ok) await bail(created, "dispatch");

  const prediction = (await created.json()) as { id?: string };
  const id = prediction.id;
  if (!id) throw new Error("The stem worker returned no job id.");

  // Separation on a 3-minute song usually lands inside 2 minutes.
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 5 ? 3000 : 5000));
    const poll = await resilientFetch(
      `${replicateBaseUrl()}/predictions/${id}`,
      { headers: credentials() },
      { label: "stem separation poll", timeoutMs: 45_000, retries: 0, baseDelayMs: 1000 },
    );
    if (!poll.ok) await bail(poll, "poll");
    const state = (await poll.json()) as { status?: string; output?: unknown; error?: unknown };
    if (state.status === "succeeded") return pickStems(state.output);
    if (state.status === "failed" || state.status === "canceled") {
      throw new Error(String(state.error ?? "Stem separation failed for this track."));
    }
  }
  throw new Error("Stem separation timed out for this track.");
}
