/**
 * Instant vocal clone (server-only).
 *
 * Studio POST /api/studio/vocal-clone (or generate with a saved take) sends
 * the recorded/uploaded clip plus lyrics. The resulting stem is archived for
 * the mixer. Provider names never leave this file.
 */
import { encode } from "@msgpack/msgpack";
import { requireFishApiKey } from "@/lib/env";
import {
  assertPipelineBreakerClosed,
  recordPipelineFailure,
  recordPipelineHttp,
  recordPipelineSuccess,
} from "@/lib/pipeline-breaker";
import {
  assertVocalContractInput,
  assertVocalContractOutput,
  logPostConditionPassed,
  logPreConditionPassed,
} from "@/lib/pipeline-contracts";
import { logPipelineStep, logPipelineStepError } from "@/lib/pipeline-steps.server";
import { logFailedStudioGate } from "@/lib/studio-pipeline-error";
import { describeFetchError } from "@/lib/safe-fetch";
import { lyricsForCloneSpeech } from "@/lib/clone-lyrics";
import { samplePathFromUrl } from "@/lib/instant-voice";
import { buildVocalClonePayload } from "@/lib/vocal-clone-payload";
import type { ApiframeResult } from "@/lib/apiframe.server";

export const FISH_AUDIO_API_BASE = "https://api.fish.audio";
export const FISH_TTS_URL = `${FISH_AUDIO_API_BASE}/v1/tts`;
/** Model tier for the `model` header. Enum: s1 | s2-pro | s2.1-pro | s2.1-pro-free. */
const FISH_MODEL = "s2-pro";
/** Synthesis of a full lyric sheet is slow, but it must never hang the render. */
const FISH_REQUEST_TIMEOUT_MS = 120_000;
const VOICE_SAMPLE_BUCKET = "voice-samples";

function fishApiKey(): string {
  return requireFishApiKey();
}

/** Model tier sent in the `model` header. */
function fishModelTier(): string {
  return process.env.FISH_AUDIO_MODEL_TIER?.trim() || FISH_MODEL;
}

/**
 * A saved voice model id from `POST /model`. When set, TTS takes the plain JSON
 * path with `reference_id` and sends no audio at all. Without one, the only way
 * to reach the artist's voice is instant cloning, which requires inline
 * reference audio over MessagePack — JSON cannot carry the binary.
 */
function fishReferenceId(): string | undefined {
  return (
    process.env.FISH_AUDIO_REFERENCE_ID?.trim() ||
    process.env.FISH_AUDIO_MODEL_ID?.trim() ||
    undefined
  );
}

function logFishConfig(): void {
  console.warn("[GATE_4_FISH_CONFIG]", {
    hasKey: !!process.env.FISH_AUDIO_API_KEY || !!process.env.FISH_API_KEY,
    modelTier: fishModelTier(),
    referenceId: fishReferenceId() ?? "NONE",
  });
}

/** Logs shape and byte sizes only — a msgpack body carries raw reference audio. */
function logFishRequest(input: {
  contentType: string;
  textLength: number;
  format: string;
  referenceId?: string;
  referenceBytes?: number[];
  totalBodyBytes: number;
}): void {
  console.warn("[GATE_4_FISH_REQUEST_PAYLOAD]:", {
    endpoint: FISH_TTS_URL,
    headers: {
      Authorization: "Bearer [REDACTED]",
      "Content-Type": input.contentType,
      model: fishModelTier(),
    },
    body: {
      textLength: input.textLength,
      format: input.format,
      referenceId: input.referenceId ?? "NONE",
      referenceCount: input.referenceBytes?.length ?? 0,
      referenceBytes: input.referenceBytes ?? [],
      totalBodyBytes: input.totalBodyBytes,
    },
  });
}

function logFishError(input: {
  status?: number;
  statusText?: string;
  data?: string;
  error?: unknown;
}): void {
  console.error("[GATE_4_FISH_ERROR_DETAILS]:", {
    status: input.status,
    statusText: input.statusText,
    data:
      input.data ??
      (input.error instanceof Error ? input.error.message : String(input.error ?? "")),
  });
}

async function loadReferenceAudio(sampleUrl: string): Promise<Uint8Array> {
  const path = samplePathFromUrl(sampleUrl);
  if (path) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.storage.from(VOICE_SAMPLE_BUCKET).download(path);
    if (!error && data) return new Uint8Array(await data.arrayBuffer());
  }

  let response: Response | undefined;
  try {
    response = await fetch(sampleUrl, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    throw new Error(`That vocal take could not be read — ${describeFetchError(error)}.`);
  }
  if (!response?.ok) throw new Error("That vocal take expired. Record or upload it again.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 256) throw new Error("That vocal take is empty. Record a cleaner clip.");
  return bytes;
}

function cloneErrorMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "Voice cloning needs to be reauthorized.";
  }
  if (status === 402) {
    return "Voice cloning has no credit left. Add billing to continue.";
  }
  if (status === 413) {
    return "That vocal take is too large. Keep clips under 25 MB.";
  }
  return "Vocal generation failed.";
}

export async function convertVocalsWithStems(input: {
  lyrics: string;
  isolatedVocal?: Uint8Array;
  referenceAudio?: Uint8Array;
  audioFormat?: "mp3" | "wav";
  title?: string;
  userId: string;
  taskId: string;
}): Promise<ApiframeResult> {
  assertPipelineBreakerClosed("vocals");
  const contract = assertVocalContractInput({ lyrics: input.lyrics, voiceId: input.taskId });
  const text = lyricsForCloneSpeech(contract.lyrics);
  if (!text) {
    throw new Error("Add lyrics before generating vocals.");
  }
  logPreConditionPassed("vocals", "target lyrics valid");

  const format = input.audioFormat === "wav" ? "wav" : "mp3";
  const referenceId = fishReferenceId();

  // A saved voice model needs no audio on the wire, so take the plain JSON
  // contract. Instant cloning has to ship the reference bytes, which only
  // MessagePack can carry.
  let contentType: string;
  let requestBody: Uint8Array;
  if (referenceId) {
    contentType = "application/json";
    requestBody = new TextEncoder().encode(
      JSON.stringify({ text, reference_id: referenceId, format }),
    );
    logFishRequest({
      contentType,
      textLength: text.length,
      format,
      referenceId,
      totalBodyBytes: requestBody.byteLength,
    });
  } else {
    const { trimVocalReference } = await import("@/lib/vocal-reference-trim.server");
    const isolatedVocal = input.isolatedVocal
      ? await trimVocalReference(input.isolatedVocal)
      : undefined;
    const extraReferences = input.referenceAudio
      ? [await trimVocalReference(input.referenceAudio)]
      : [];
    const payload = buildVocalClonePayload({
      text,
      audio: isolatedVocal,
      extraReferences,
      format,
    });
    contentType = "application/msgpack";
    requestBody = encode(payload);
    logFishRequest({
      contentType,
      textLength: payload.text.length,
      format: payload.format,
      referenceBytes: payload.references?.map((ref) => ref.audio.byteLength) ?? [],
      totalBodyBytes: requestBody.byteLength,
    });
  }

  const apiKey = fishApiKey();
  console.warn("[FISH_AUDIO_DISPATCH] Processing vocal refinement...");
  logFishConfig();
  logPipelineStep("vocals");
  console.warn("[GATE_4_START_FETCH]", {
    contentLength: requestBody.byteLength,
    contentType,
  });
  let response: Response | undefined;
  try {
    response = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
        model: fishModelTier(),
      },
      body: Buffer.from(requestBody),
      signal: AbortSignal.timeout(FISH_REQUEST_TIMEOUT_MS),
    });
    console.warn("[GATE_4_FETCH_STATUS]", response.status, response.statusText);
  } catch (error) {
    recordPipelineFailure("vocals", error);
    logFailedStudioGate(error);
    console.error("[GATE_4_FAIL] vocal synthesis never returned", error);
    logFishError({ error });
    logPipelineStepError("vocals", error);
    throw new Error(`Voice cloning is unreachable — ${describeFetchError(error)}.`);
  }

  if (!response) throw new Error("Voice cloning is unreachable — no response from the engine.");
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    recordPipelineHttp("vocals", response.status);
    console.error("[GATE_4_FAIL]", response.status, response.statusText);
    logFishError({ status: response.status, statusText: response.statusText, data: errorBody });
    logPipelineStepError("vocals", new Error(cloneErrorMessage(response.status)), {
      status: response.status,
      body: errorBody,
    });
    throw new Error(cloneErrorMessage(response.status));
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const { archiveGeneratedAudioBytes } = await import("@/lib/apiframe.server");
  const audioUrl = await archiveGeneratedAudioBytes(
    bytes,
    input.userId,
    input.taskId,
    format === "wav" ? "audio/wav" : "audio/mpeg",
  );
  const output = assertVocalContractOutput(audioUrl);
  recordPipelineSuccess("vocals");
  logPostConditionPassed("Synth vocal ready for mastering");

  return {
    taskId: input.taskId,
    status: "succeeded",
    tracks: [
      {
        id: input.taskId,
        title: input.title || "Vocal stem",
        audioUrl: output.synthVocalUrl,
        imageUrl: null,
        duration: null,
      },
    ],
    raw: { cloned: true, fish: true },
  };
}

export async function cloneVocalsFromBytes(
  input: {
    audioBytes: Uint8Array;
    lyrics: string;
    audioFormat?: "mp3" | "wav";
    title?: string;
    userId: string;
    taskId: string;
  },
): Promise<ApiframeResult> {
  if (input.audioBytes.byteLength < 256) {
    throw new Error("That vocal take is empty. Record a cleaner clip.");
  }
  return convertVocalsWithStems({
    lyrics: input.lyrics,
    referenceAudio: input.audioBytes,
    audioFormat: input.audioFormat,
    title: input.title,
    userId: input.userId,
    taskId: input.taskId,
  });
}

export async function cloneVocalsFromSample(
  input: {
    sampleUrl: string;
    lyrics: string;
    language?: string;
    customLanguage?: string;
    audioFormat?: "mp3" | "wav";
    title?: string;
    userId: string;
    taskId: string;
    voiceId?: string;
  },
): Promise<ApiframeResult> {
  const { logApiPayload } = await import("@/lib/generation-style-prompt");
  logApiPayload({
    engine: "fish-tts-clone",
    voice_id: input.voiceId ?? null,
    reference_audio: input.sampleUrl,
    lyrics: input.lyrics,
    audioFormat: input.audioFormat === "wav" ? "wav" : "mp3",
  });
  const audioBytes = await loadReferenceAudio(input.sampleUrl);
  return cloneVocalsFromBytes({
    audioBytes,
    lyrics: input.lyrics,
    audioFormat: input.audioFormat,
    title: input.title,
    userId: input.userId,
    taskId: input.taskId,
  });
}
