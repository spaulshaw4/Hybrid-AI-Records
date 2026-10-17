/**
 * Selective lip-sync stage (server only).
 *
 * Shots the planner tagged `vocalSync` are re-rendered through WaveSpeed
 * `sync/lipsync-3` (confirmed docs path) with the audio slice under that shot.
 * There is no Replicate fallback and no second model id.
 */

import { WAVESPEED_API_ROOT, wavespeedHeaders } from "@/lib/ai-provider.server";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import {
  isWaveSpeedFailure,
  isWaveSpeedSuccess,
  redactSecrets,
  waveSpeedErrorText,
  waveSpeedId,
  waveSpeedModelUrl,
  waveSpeedOutputUrl,
  waveSpeedResultUrl,
  waveSpeedStatus,
} from "@/lib/wavespeed-prediction.server";

/** Confirmed WaveSpeed lip-sync model. https://wavespeed.ai/docs/docs-api/sync/sync-lipsync-3 */
export const LIPSYNC_MODEL = "sync/lipsync-3";

const UPLOAD_URL = `${WAVESPEED_API_ROOT}/media/uploads`;

function credentials(): Record<string, string> {
  return wavespeedHeaders("The lip-sync engine");
}

async function failure(response: Response, what: string): Promise<never> {
  const body = redactSecrets(await response.text());
  if (response.status === 402) {
    throw new Error(
      "The lip-sync engine has no render credit left. Top it up and retry this shot.",
    );
  }
  console.error(`Lip-sync ${what} failed [${response.status}]: ${body}`);
  throw new Error(`Lip-sync ${what} failed [${response.status}]: ${body.slice(0, 400)}`);
}

async function readJson(response: Response): Promise<{ text: string; json: unknown | null }> {
  const text = await response.text().catch(() => "");
  try {
    return { text, json: JSON.parse(text) as unknown };
  } catch {
    return { text, json: null };
  }
}

/**
 * Uploads the sliced wav through the confirmed media-upload ticket, then
 * returns `data.download_url`. The storage PUT carries the ticket headers
 * only — never the API key, and never a Replicate token.
 */
async function uploadAudioSlice(bytes: Uint8Array, filename: string): Promise<string> {
  let ticketResponse: Response;
  try {
    ticketResponse = await resilientFetch(
      UPLOAD_URL,
      {
        method: "POST",
        headers: credentials(),
        body: JSON.stringify({
          filename,
          size: bytes.byteLength,
          content_type: "audio/wav",
        }),
      },
      { label: "lip-sync audio upload", timeoutMs: 120_000, retries: 0, useBreaker: false },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Lip-sync audio upload failed — ${reason}`);
  }
  if (!ticketResponse.ok) await failure(ticketResponse, "audio upload");
  const ticket = await readJson(ticketResponse);
  const data =
    ticket.json && typeof ticket.json === "object" && !Array.isArray(ticket.json)
      ? ((ticket.json as Record<string, unknown>).data as Record<string, unknown> | undefined)
      : undefined;
  const upload =
    data?.upload && typeof data.upload === "object" && !Array.isArray(data.upload)
      ? (data.upload as Record<string, unknown>)
      : null;
  const downloadUrl = typeof data?.download_url === "string" ? data.download_url : "";
  const uploadUrl = typeof upload?.url === "string" ? upload.url : "";
  const method = typeof upload?.method === "string" ? upload.method : "";
  const rawHeaders =
    upload?.headers && typeof upload.headers === "object" && !Array.isArray(upload.headers)
      ? (upload.headers as Record<string, unknown>)
      : null;
  const headers: Record<string, string> = {};
  if (rawHeaders) {
    for (const [key, value] of Object.entries(rawHeaders)) {
      if (typeof value !== "string") continue;
      if (key.toLowerCase() === "authorization") continue;
      headers[key] = value;
    }
  }
  if (!downloadUrl || !uploadUrl || !method || Object.keys(headers).length === 0) {
    throw new Error("The lip-sync engine returned no audio URL.");
  }

  const payload = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(payload).set(bytes);

  let put: Response;
  try {
    put = await resilientFetch(
      uploadUrl,
      { method, headers, body: payload },
      { label: "lip-sync audio put", timeoutMs: 120_000, retries: 0, useBreaker: false },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Lip-sync audio upload failed — ${reason}`);
  }
  if (!put.ok) await failure(put, "audio upload");
  return downloadUrl;
}

/**
 * Runs `sync/lipsync-3` on one shot and returns the synced clip URL.
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

  let created: Response;
  try {
    created = await resilientFetch(
      waveSpeedModelUrl(LIPSYNC_MODEL),
      {
        method: "POST",
        headers: credentials(),
        body: JSON.stringify({
          video: input.videoUrl,
          audio: audioUrl,
          sync_mode: "cut_off",
        }),
      },
      {
        label: `lip-sync dispatch (${LIPSYNC_MODEL})`,
        timeoutMs: 180_000,
        retries: 0,
        useBreaker: false,
      },
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Lip-sync dispatch failed — ${reason}`);
  }
  if (!created.ok) await failure(created, "dispatch");
  const submitted = await readJson(created);
  const id = waveSpeedId(submitted.json);
  if (!id) throw new Error("The lip-sync engine returned no job id.");

  const started = Date.now();
  for (;;) {
    if (Date.now() - started > 180_000) {
      throw new Error("The lip-sync pass timed out for this shot.");
    }
    const poll = await resilientFetch(
      waveSpeedResultUrl(id),
      { headers: credentials() },
      {
        label: "lip-sync poll",
        timeoutMs: 45_000,
        retries: 0,
        baseDelayMs: 1000,
        useBreaker: false,
      },
    );
    if (!poll.ok) await failure(poll, "poll");
    const state = await readJson(poll);
    const status = waveSpeedStatus(state.json);
    if (isWaveSpeedSuccess(status)) {
      const output = waveSpeedOutputUrl(state.json);
      if (output && output.startsWith("http")) return output;
      throw new Error("The lip-sync engine returned no clip.");
    }
    if (isWaveSpeedFailure(status)) {
      throw new Error(
        redactSecrets(waveSpeedErrorText(state.json) ?? "The lip-sync pass failed for this shot."),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
}
