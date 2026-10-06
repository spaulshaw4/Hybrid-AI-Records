import { createRequire } from "node:module";
import { createClient } from "@supabase/supabase-js";
import { formatMurekaLyrics, formatMurekaPrompt } from "@/lib/mureka-format";
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

type GenerateBody = {
  title?: unknown;
  prompt?: unknown;
  lyrics?: unknown;
  gender?: unknown;
  isInstrumental?: unknown;
  vocalId?: unknown;
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
  return Buffer.concat(mp3Data.map((chunk) => Buffer.from(chunk)));
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
      userId: rawUserId,
    } = (await req.json()) as GenerateBody;
    const prompt = formatMurekaPrompt(typeof rawPrompt === "string" ? rawPrompt : "");
    const lyrics = formatMurekaLyrics(typeof rawLyrics === "string" ? rawLyrics : "");
    const isInstrumental = rawInstrumental === true;
    const title =
      typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : "Untitled Master";
    const userId = typeof rawUserId === "string" ? rawUserId.trim() : "";
    const vocalUsed = vocalId && String(vocalId).trim() !== "" ? String(vocalId).trim() : "";

    const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
    if (!apiKey) {
      return Response.json({ error: "Missing WaveSpeed API key" }, { status: 500 });
    }

    const endpoint = isInstrumental ? GENERATE_BGM_URL : GENERATE_SONG_URL;
    const resolvedGender = (typeof gender === "string" ? gender.trim() : "") || "male";
    const payload = isInstrumental
      ? {
          prompt,
          output_format: "wav" as const,
        }
      : {
          prompt,
          lyrics,
          gender: resolvedGender,
          output_format: "wav" as const,
        };

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

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(POLL_INTERVAL_MS);
      const pollRes = await fetch(
        `https://api.wavespeed.ai/api/v3/predictions/${encodeURIComponent(taskId)}/result`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!pollRes.ok) {
        console.log(`[generate] poll ${attempt + 1} task ${taskId} http ${pollRes.status}`);
        continue;
      }

      const pollData = (await pollRes.json()) as {
        data?: { status?: string; outputs?: unknown[] };
      };
      const status = pollData.data?.status;
      console.log(`[generate] poll ${attempt + 1} task ${taskId} status ${status ?? "pending"}`);
      if (status === "completed") {
        const outputUrl = pollData.data?.outputs?.[0];
        if (typeof outputUrl !== "string" || !outputUrl) {
          throw new Error("Generation failed upstream");
        }
        const wavRes = await fetch(outputUrl);
        if (!wavRes.ok) {
          throw new Error("Generation failed upstream");
        }
        const wavBuffer = Buffer.from(await wavRes.arrayBuffer());
        const mp3Buffer = transcodeWavToMp3(wavBuffer);

        const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
        const supabase = vaultClient();
        const wavPath = `masters/${taskId}.wav`;
        const mp3Path = `masters/${taskId}.mp3`;
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
          throw new Error(
            wavUpload.error?.message || mp3Upload.error?.message || "Vault upload failed",
          );
        }

        const cdnBase = `${supabaseUrl}/storage/v1/object/public/${VAULT_BUCKET}`;
        const wavUrl = `${cdnBase}/${wavPath}`;
        const mp3Url = `${cdnBase}/${mp3Path}`;

        if (userId) {
          const { error: insertError } = await supabase.from("vaulted_tracks").insert({
            user_id: userId,
            title,
            prompt,
            lyrics: isInstrumental ? null : lyrics,
            vocal_id_used: vocalUsed || null,
            wav_url: wavUrl,
            mp3_url: mp3Url,
            task_id: taskId,
          });
          if (insertError) throw new Error(insertError.message);
        }

        return Response.json({
          success: true,
          wavUrl,
          mp3Url,
        });
      }
      if (status === "failed" || status === "cancelled") {
        return Response.json({ error: "Generation failed upstream" }, { status: 500 });
      }
    }

    return Response.json({ error: "Task hit the 6-minute engine ceiling" }, { status: 504 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    return Response.json({ error: message || "Internal server error" }, { status: 500 });
  }
}
