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
const FISH_MODEL = "s2-pro";
const VOICE_SAMPLE_BUCKET = "voice-samples";

function fishApiKey(): string {
  return requireFishApiKey();
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
  const extraReferences = input.referenceAudio ? [input.referenceAudio] : [];
  const body = encode(
    buildVocalClonePayload({
      text,
      audio: input.isolatedVocal,
      extraReferences,
      format,
    }),
  );

  const apiKey = fishApiKey();
  console.log("[FISH_AUDIO_DISPATCH] Processing vocal refinement...");
  logPipelineStep("vocals");
  let response: Response | undefined;
  try {
    response = await fetch(FISH_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/msgpack",
        model: FISH_MODEL,
      },
      body: Buffer.from(body),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    recordPipelineFailure("vocals", error);
    logFailedStudioGate(error);
    logPipelineStepError("vocals", error);
    throw new Error(`Voice cloning is unreachable — ${describeFetchError(error)}.`);
  }

  if (!response) throw new Error("Voice cloning is unreachable — no response from the engine.");
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    recordPipelineHttp("vocals", response.status);
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
