import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import {
  formatMurekaLyrics,
  formatMurekaPrompt,
  replaceBareConflictingPrompt,
} from "@/lib/mureka-format";
import {
  beginDelivery,
  completeTrackJob,
  failTrackJob,
  readTrackJob,
  rememberTrackJob,
  WAVESPEED_TRACK_WEBHOOK_URL,
  type TrackJob,
} from "@/lib/wavespeed-track-jobs.server";
// @ts-ignore lamejs has no published @types/lamejs package
import lamejs from "lamejs";

const require = createRequire(import.meta.url);

/**
 * lamejs looks up MPEGMode, Lame, and BitStream as free variables (browser bundle globals).
 * Node's module build does not attach them, so the encoder throws unless they are installed first.
 */
function ensureLamejsRuntime(): void {
  const runtime = globalThis as typeof globalThis & {
    MPEGMode?: unknown;
    Lame?: unknown;
    BitStream?: unknown;
  };
  if (!runtime.MPEGMode) runtime.MPEGMode = require("lamejs/src/js/MPEGMode.js");
  if (!runtime.Lame) runtime.Lame = require("lamejs/src/js/Lame.js");
  if (!runtime.BitStream) runtime.BitStream = require("lamejs/src/js/BitStream.js");
}

const GENERATE_SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const GENERATE_BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";

/** Harmless on Bun. Next.js route segment config when this file is used as a route. */
export const maxDuration = 360;

const POLL_INTERVAL_MS = 3000;
const maxAttempts = 120;
const VAULT_BUCKET = "audio-vault";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WaveSpeed accepts only lowercase "male" or "female". "Male (m)" is ignored. */
export function normalizeVocalGender(gender: unknown): "male" | "female" {
  const text = typeof gender === "string" ? gender.trim().toLowerCase() : "";
  if (text.startsWith("female")) return "female";
  if (text.startsWith("male")) return "male";
  return "male";
}

const MALE_VOCAL_LEAD = "Deep soulful male vocal, baritone delivery, ";
const FEMALE_VOCAL_LEAD = "Female vocal, ";

/**
 * Mureka defaults to female pop when the prompt never names the singer.
 * The gender field alone does not lock it; the prompt text has to.
 */
export function promptWithVocalGender(prompt: string, gender: "male" | "female"): string {
  if (gender === "female") {
    if (/\bfemale vocal\b/i.test(prompt)) return prompt;
    return `${FEMALE_VOCAL_LEAD}${prompt}`;
  }
  if (/\bmale vocal\b|\bbaritone\b/i.test(prompt)) return prompt;
  return `${MALE_VOCAL_LEAD}${prompt}`;
}

type GenerateBody = {
  title?: unknown;
  prompt?: unknown;
  lyrics?: unknown;
  gender?: unknown;
  isInstrumental?: unknown;
  vocalId?: unknown;
  referenceId?: unknown;
  userId?: unknown;
};

function vaultClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

/**
 * 320 kbps MP3 from the WAV bytes just downloaded. A throw is a failed generate.
 */
export function transcodeWavToMp3(wavBuffer: Buffer): Buffer {
  ensureLamejsRuntime();
  const arrayBuffer = wavBuffer.buffer.slice(
    wavBuffer.byteOffset,
    wavBuffer.byteOffset + wavBuffer.byteLength,
  ) as ArrayBuffer;
  const wav = lamejs.WavHeader.readHeader(new DataView(arrayBuffer));
  if (!wav?.dataLen || !wav.channels || !wav.sampleRate) {
    throw new Error("Invalid WAV header");
  }
  const samples = new Int16Array(arrayBuffer, wav.dataOffset, wav.dataLen / 2);
  const channels = wav.channels;
  const sampleRate = wav.sampleRate;
  const encoder = new lamejs.Mp3Encoder(channels, sampleRate, 320);
  const blockSize = 1152;
  const mp3Data: Int8Array[] = [];

  if (channels === 1) {
    for (let i = 0; i < samples.length; i += blockSize) {
      const chunk = samples.subarray(i, i + blockSize);
      const mp3buf = encoder.encodeBuffer(chunk);
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }
  } else {
    const left = new Int16Array(samples.length / 2);
    const right = new Int16Array(samples.length / 2);
    for (let i = 0; i < samples.length; i += 2) {
      left[i / 2] = samples[i] ?? 0;
      right[i / 2] = samples[i + 1] ?? 0;
    }
    for (let i = 0; i < left.length; i += blockSize) {
      const mp3buf = encoder.encodeBuffer(
        left.subarray(i, i + blockSize),
        right.subarray(i, i + blockSize),
      );
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }
  }

  const flushed = encoder.flush();
  if (flushed.length > 0) mp3Data.push(flushed);
  // Each chunk is an Int8Array view. Copy only its byte range so the frame stays intact.
  const mp3Buffer = Buffer.concat(
    mp3Data.map((arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)),
  );
  if (mp3Buffer.length < 2 || mp3Buffer[0] !== 0xff || (mp3Buffer[1] & 0xe0) !== 0xe0) {
    throw new Error("MP3 encode produced an empty or header-less buffer");
  }
  return mp3Buffer;
}

const TERMINAL_FAIL = new Set(["failed", "cancelled", "timeout", "deleted"]);

function resultUrl(taskId: string): string {
  return `https://api.wavespeed.ai/api/v3/predictions/${encodeURIComponent(taskId)}/result`;
}

function readResultStatus(body: {
  data?: { status?: string };
  status?: string;
}): string {
  const status = body.data?.status ?? body.status;
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function readResultOutput(body: {
  data?: { outputs?: unknown[] };
  outputs?: unknown[];
}): string {
  const outputs = body.data?.outputs ?? body.outputs;
  const first = Array.isArray(outputs) ? outputs[0] : undefined;
  return typeof first === "string" ? first.trim() : "";
}

async function vaultCompletedWav(
  job: TrackJob,
  outputUrl: string,
): Promise<{ wavUrl: string; mp3Url: string }> {
  const wavRes = await fetch(outputUrl);
  if (!wavRes.ok) {
    throw new Error("Generation failed upstream");
  }
  const wavBuffer = Buffer.from(await wavRes.arrayBuffer());
  const mp3Buffer = transcodeWavToMp3(wavBuffer);

  const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const supabase = vaultClient();
  const wavPath = `masters/${job.taskId}.wav`;
  const mp3Path = `masters/${job.taskId}.mp3`;
  const [wavUpload, mp3Upload] = await Promise.all([
    supabase.storage.from(VAULT_BUCKET).upload(wavPath, wavBuffer, {
      contentType: "audio/wav",
      upsert: true,
    }),
    supabase.storage.from(VAULT_BUCKET).upload(mp3Path, mp3Buffer, {
      contentType: "audio/mpeg",
      upsert: true,
    }),
  ]);
  if (wavUpload.error || mp3Upload.error) {
    throw new Error(wavUpload.error?.message || mp3Upload.error?.message || "Vault upload failed");
  }

  const cdnBase = `${supabaseUrl}/storage/v1/object/public/${VAULT_BUCKET}`;
  const wavUrl = `${cdnBase}/${wavPath}`;
  const mp3Url = `${cdnBase}/${mp3Path}`;

  if (job.userId) {
    const { error: insertError } = await supabase.from("vaulted_tracks").insert({
      user_id: job.userId,
      title: job.title,
      prompt: job.prompt,
      lyrics: job.lyrics,
      vocal_id_used: job.vocalId,
      wav_url: wavUrl,
      mp3_url: mp3Url,
      task_id: job.taskId,
    });
    if (insertError) throw new Error(insertError.message);
  }

  return { wavUrl, mp3Url };
}

/**
 * Confirm the prediction with WaveSpeed, then vault once.
 * The webhook body is not trusted for the audio URL.
 */
export async function settleTrackFromWaveSpeed(taskId: string): Promise<void> {
  const existing = readTrackJob(taskId);
  if (!existing || existing.status !== "processing" || existing.delivering) return;

  const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
  if (!apiKey) {
    failTrackJob(taskId, "Missing WaveSpeed API key");
    return;
  }

  const pollRes = await fetch(resultUrl(taskId), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!pollRes.ok) {
    console.log(`[generate] task ${taskId} result http ${pollRes.status}`);
    return;
  }

  let pollData: {
    data?: { status?: string; outputs?: unknown[] };
    status?: string;
    outputs?: unknown[];
  };
  try {
    pollData = (await pollRes.json()) as typeof pollData;
  } catch {
    return;
  }

  const status = readResultStatus(pollData);
  console.log(`[generate] task ${taskId} status ${status || "pending"}`);
  if (!status || status === "processing" || status === "created" || status === "pending") return;
  if (TERMINAL_FAIL.has(status)) {
    failTrackJob(taskId, "Generation failed upstream");
    return;
  }
  if (status !== "completed") return;

  const outputUrl = readResultOutput(pollData);
  if (!outputUrl.startsWith("https://")) {
    failTrackJob(taskId, "Generation failed upstream");
    return;
  }

  const job = beginDelivery(taskId);
  if (!job) return;
  try {
    const urls = await vaultCompletedWav(job, outputUrl);
    completeTrackJob(taskId, urls);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    failTrackJob(taskId, message || "Generation failed upstream");
  }
}

/** Keep checking after the HTTP response has already returned. */
export async function watchTrack(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    const current = readTrackJob(taskId);
    if (!current || current.status !== "processing") return;
    try {
      await settleTrackFromWaveSpeed(taskId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "";
      console.error("[generate] watch error", message || "error");
    }
    const after = readTrackJob(taskId);
    if (!after || after.status !== "processing") return;
  }
  failTrackJob(taskId, "Task hit the 6-minute engine ceiling");
}

function startTrackWatch(taskId: string): void {
  // Unit tests drive delivery through the webhook. The live server watches in the background.
  if (process.env.VITEST === "true") return;
  void watchTrack(taskId);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const {
      title: rawTitle,
      prompt: rawPrompt,
      lyrics: rawLyrics,
      gender,
      isInstrumental: rawInstrumental,
      vocalId,
      referenceId: rawReferenceId,
      userId: rawUserId,
    } = (await req.json()) as GenerateBody;
    const formattedPrompt = replaceBareConflictingPrompt(
      formatMurekaPrompt(typeof rawPrompt === "string" ? rawPrompt : ""),
    );
    const lyrics = formatMurekaLyrics(typeof rawLyrics === "string" ? rawLyrics : "");
    const isInstrumental = rawInstrumental === true;
    const title =
      typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : "Untitled Master";
    const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
    const vocalUsed = vocalId && String(vocalId).trim() !== "" ? String(vocalId).trim() : "";
    const vocalGender = normalizeVocalGender(gender);
    const prompt =
      !isInstrumental && !vocalUsed
        ? promptWithVocalGender(formattedPrompt, vocalGender)
        : formattedPrompt;

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WaveSpeed API key" }, { status: 500 });
    }

    const endpoint = isInstrumental ? GENERATE_BGM_URL : GENERATE_SONG_URL;
    const referenceId = typeof rawReferenceId === "string" ? rawReferenceId.trim() : "";
    const payload: {
      prompt: string;
      output_format: "wav";
      webhook: string;
      reference_id?: string;
      lyrics?: string;
      gender?: string;
      vocal_id?: string;
    } = {
      prompt,
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    };
    if (referenceId) payload.reference_id = referenceId;
    if (!isInstrumental) {
      payload.lyrics = lyrics;
      if (vocalUsed) payload.vocal_id = vocalUsed;
      else payload.gender = vocalGender;
    }

    const submitRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const submitData = (await submitRes.json()) as {
      data?: { id?: string };
      message?: string;
      error?: string;
    };
    const taskId = submitData.data?.id;
    if (!taskId) {
      console.error("WaveSpeed Raw Rejection:", JSON.stringify(submitData, null, 2));
      return Response.json(
        {
          error: `WaveSpeed rejected: ${submitData.message || submitData.error || JSON.stringify(submitData)}`,
        },
        { status: 500 },
      );
    }
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) {
      throw new Error("Task submission rejected by upstream");
    }
    console.log(`[generate] WaveSpeed accepted task ${taskId}`);
    rememberTrackJob({
      taskId,
      title,
      prompt,
      lyrics: isInstrumental ? null : lyrics,
      vocalId: vocalUsed || null,
      userId,
      status: "processing",
      delivering: false,
    });
    startTrackWatch(taskId);

    return Response.json({
      success: true,
      status: "pending",
      taskId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    return Response.json({ error: message || "Internal server error" }, { status: 500 });
  }
}
