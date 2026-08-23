import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import {
  AUDIO_VAULT_BUCKET,
  AUDIO_VAULT_MAX_BYTES,
  vaultMasterObjectPath,
  vaultMimeType,
  type VaultAudioFileType,
} from "@/lib/audio-vault";

const SIGNED_URL_TTL = 60 * 60 * 24 * 365;
const STREAM_HIGH_WATER_MARK = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;

type VaultUploadBody = Uint8Array | Buffer | Readable | ReadableStream<Uint8Array>;

function assertWithinLimit(byteLength: number) {
  if (byteLength > AUDIO_VAULT_MAX_BYTES) {
    throw new Error("That audio file is larger than the 150 MB vault limit.");
  }
}

function asNodeReadable(body: Uint8Array | Buffer): Readable {
  return Readable.from(body, { highWaterMark: STREAM_HIGH_WATER_MARK });
}

async function persistVaultObject(
  path: string,
  body: VaultUploadBody,
  mimeType: string,
): Promise<string> {
  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
    const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
    return uploadEngineMaster(bytes, path, mimeType.includes("wav") ? "wav" : "mp3");
  }

  const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
  const supabaseAdmin = requireSupabaseAdmin();
  const { error } = await supabaseAdmin.storage.from(AUDIO_VAULT_BUCKET).upload(path, body, {
    contentType: mimeType === "audio/wav" || mimeType.includes("wav")
      ? "audio/wav"
      : mimeType.includes("mpeg") || mimeType.includes("mp3")
        ? "audio/mpeg"
        : mimeType,
    upsert: true,
    cacheControl: "31536000",
    duplex: "half",
    headers: {
      "content-type":
        mimeType === "audio/wav" || mimeType.includes("wav")
          ? "audio/wav"
          : mimeType.includes("mpeg") || mimeType.includes("mp3")
            ? "audio/mpeg"
            : mimeType,
    },
  });
  if (error) {
    console.error("[audio-vault] upload failed:", error.message, error);
    throw new Error(`The finished track could not be saved to the audio vault: ${error.message}`);
  }

  const { data, error: signError } = await supabaseAdmin.storage
    .from(AUDIO_VAULT_BUCKET)
    .createSignedUrl(path, SIGNED_URL_TTL);
  if (!signError && data?.signedUrl) return data.signedUrl;

  const { data: publicData } = supabaseAdmin.storage.from(AUDIO_VAULT_BUCKET).getPublicUrl(path);
  if (publicData?.publicUrl) return publicData.publicUrl;
  throw new Error("The finished track could not be opened for playback.");
}

/**
 * Streams a master into `audio-vault` with an explicit Content-Type so large
 * WAV/MP3/FLAC renders (up to 150 MB) do not stall on a missing MIME header.
 *
 * Object key: `masters/{trackId}_master.{wav|mp3|flac}`
 */
export async function uploadMasterToVault(
  body: Uint8Array | Buffer | Readable | ReadableStream<Uint8Array>,
  trackId: string,
  fileType: string = "wav",
): Promise<string> {
  const mimeType = vaultMimeType(fileType);
  const path = vaultMasterObjectPath(trackId, fileType);

  if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
    assertWithinLimit(body.byteLength);
    return persistVaultObject(path, asNodeReadable(body), mimeType);
  }

  return persistVaultObject(path, body, mimeType);
}

/** Same contract as `upload_master_to_vault(local_file_path, track_id, file_type)`. */
export async function uploadMasterToVaultFromPath(
  localFilePath: string,
  trackId: string,
  fileType: string = "wav",
): Promise<string> {
  const info = await stat(localFilePath);
  assertWithinLimit(info.size);
  const stream = createReadStream(localFilePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
  return uploadMasterToVault(stream, trackId, fileType);
}

/** Copies an already-archived stem URL into the audio-vault master object. */
export async function uploadMasterToVaultFromUrl(
  sourceUrl: string,
  trackId: string,
  fileType: VaultAudioFileType | string = "mp3",
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(sourceUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch {
    throw new Error("The finished audio could not be downloaded for the vault.");
  }
  if (!response.ok) throw new Error("The finished audio expired before it could be saved.");

  const declared = Number(response.headers.get("content-length") || "0");
  if (declared > AUDIO_VAULT_MAX_BYTES) {
    throw new Error("That audio file is larger than the 150 MB vault limit.");
  }

  const headerType = response.headers.get("content-type") ?? "";
  const mimeType =
    /audio\/(wav|x-wav|mpeg|mp3|flac)/i.test(headerType) ? headerType.split(";")[0]!.trim() : vaultMimeType(fileType);

  if (response.body) {
    return persistVaultObject(vaultMasterObjectPath(trackId, fileType), response.body, mimeType);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  assertWithinLimit(bytes.byteLength);
  return uploadMasterToVault(bytes, trackId, fileType);
}
