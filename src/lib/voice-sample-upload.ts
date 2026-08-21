/**
 * Uploads a short voice sample (mic recording or pre-recorded clip) to the
 * private "voice-samples" bucket and returns a signed https URL the MiniMax
 * cloning job can download from.
 */
import { supabase } from "@/integrations/supabase/client";
import { logUploadAction } from "@/lib/upload-audit";

export const VOICE_SAMPLE_BUCKET = "voice-samples";
export const VOICE_SAMPLE_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const VOICE_SAMPLE_ACCEPT = ".mp3,.wav,audio/mpeg,audio/wav,audio/webm";
const ALLOWED_EXTENSIONS = [".mp3", ".wav", ".webm", ".m4a"];
/** Long enough for the clone job to fetch the clip. */
const SIGNED_URL_SECONDS = 60 * 60 * 2;

export type VoiceSampleUploadResult =
  | { ok: true; url: string; name: string; path: string; metadataPath: string | null }
  | { ok: false; message: string };

/**
 * Trim selection + quality analysis stored alongside the clip so the exact
 * source window and grading can be audited later.
 */
export type VoiceSampleMetadata = {
  trimStartSeconds: number;
  trimEndSeconds: number;
  trimDurationSeconds: number;
  sourceDurationSeconds: number;
  quality: {
    peak: number;
    rms: number;
    clipRatio: number;
    silenceRatio: number;
    blocked: boolean;
    issues: { level: string; message: string }[];
  } | null;
};

/** Storage user-metadata is header-encoded, so keep values short and flat. */
function flattenMetadata(meta: VoiceSampleMetadata, originalName: string) {
  const round = (n: number, digits = 4) => Number(n.toFixed(digits));
  return {
    originalName,
    trimStartSeconds: round(meta.trimStartSeconds, 3),
    trimEndSeconds: round(meta.trimEndSeconds, 3),
    trimDurationSeconds: round(meta.trimDurationSeconds, 3),
    sourceDurationSeconds: round(meta.sourceDurationSeconds, 3),
    peak: meta.quality ? round(meta.quality.peak) : null,
    rms: meta.quality ? round(meta.quality.rms) : null,
    clipRatio: meta.quality ? round(meta.quality.clipRatio) : null,
    silenceRatio: meta.quality ? round(meta.quality.silenceRatio) : null,
    qualityBlocked: meta.quality ? meta.quality.blocked : null,
    qualityIssues: meta.quality ? meta.quality.issues.map((i) => `${i.level}:${i.message}`).join(" | ") : "",
    analysedAt: new Date().toISOString(),
  };
}

/** base64 (ASCII-safe) encoding for the storage x-metadata header. */
function encodeMetadataHeader(value: unknown) {
  const json = JSON.stringify(value);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Byte-level progress reporter for the storage upload. */
export type UploadProgress = {
  loaded: number;
  total: number;
  /** 0-100, or null while the total size is unknown. */
  percent: number | null;
};

/**
 * Uploads via XHR so we get real byte progress events (the Supabase JS client
 * uses fetch, which cannot report upload progress). Resolves false when the
 * transport itself is unavailable so the caller can fall back to the SDK.
 */
async function xhrUpload(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress?: (p: UploadProgress) => void,
): Promise<{ ok: true } | { ok: false; retryable: boolean; message: string }> {
  if (typeof XMLHttpRequest === "undefined") {
    return { ok: false, retryable: true, message: "No upload transport" };
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => {
      onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
        percent: event.lengthComputable && event.total > 0
          ? Math.min(100, Math.round((event.loaded / event.total) * 100))
          : null,
      });
    };
    xhr.onerror = () => resolve({ ok: false, retryable: true, message: "Network error during upload" });
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          retryable: xhr.status === 0 || xhr.status >= 500,
          message: `Upload rejected (${xhr.status})`,
        });
      }
    };
    xhr.send(file);
  });
}


function extensionOf(name: string) {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function safeName(name: string) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "sample.wav";
}

/** Records the clip upload (and its exact storage metadata) in the audit log. */
async function auditClipUpload(args: {
  path: string;
  file: File;
  outcome: "success" | "failed";
  errorMessage?: string;
  details: Record<string, unknown>;
}) {
  await logUploadAction({
    action: "upload",
    bucket: VOICE_SAMPLE_BUCKET,
    objectPath: args.path,
    fileName: args.file.name,
    fileSize: args.file.size,
    outcome: args.outcome,
    errorMessage: args.errorMessage ?? null,
    details: args.details,
  });
}

export async function uploadVoiceSample(
  file: File,
  onProgress?: (p: UploadProgress) => void,
  metadata?: VoiceSampleMetadata,
): Promise<VoiceSampleUploadResult> {
  const ext = extensionOf(file.name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, message: "Use an .mp3 or .wav voice clip (or record one right here)." };
  }
  if (file.size === 0) {
    return { ok: false, message: "That clip is empty — record or pick another file." };
  }
  if (file.size > VOICE_SAMPLE_MAX_BYTES) {
    return { ok: false, message: "That clip is over 25 MB. A clean 10-second sample is plenty." };
  }

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return { ok: false, message: "Sign in before uploading a voice sample." };

  const path = `${userId}/${Date.now()}-${safeName(file.name)}`;
  const contentType = file.type || "audio/wav";
  const flatMetadata = metadata ? flattenMetadata(metadata, file.name) : null;

  onProgress?.({ loaded: 0, total: file.size, percent: 0 });

  const baseUrl = import.meta.env["VITE_SUPABASE_URL"] as string | undefined;
  const apiKey = import.meta.env["VITE_SUPABASE_PUBLISHABLE_KEY"] as string | undefined;
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;

  let uploaded = false;
  let transport: "xhr" | "sdk" = "sdk";
  if (baseUrl && apiKey && accessToken) {
    const result = await xhrUpload(
      `${baseUrl.replace(/\/$/, "")}/storage/v1/object/${VOICE_SAMPLE_BUCKET}/${path}`,
      file,
      {
        apikey: apiKey,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": contentType,
        "x-upsert": "false",
        "cache-control": "3600",
        ...(flatMetadata ? { "x-metadata": encodeMetadataHeader(flatMetadata) } : {}),
      },
      onProgress,
    );
    if (result.ok) {
      uploaded = true;
      transport = "xhr";
    } else if (!result.retryable) {
      await auditClipUpload({
        path,
        file,
        outcome: "failed",
        errorMessage: result.message,
        details: { transport: "xhr", contentType, storageMetadata: flatMetadata, uploadedBy: userId },
      });
      return { ok: false, message: "Upload failed. Check your connection and try that clip again." };
    }
  }

  if (!uploaded) {
    const { error } = await supabase.storage
      .from(VOICE_SAMPLE_BUCKET)
      .upload(path, file, {
        upsert: false,
        contentType,
        ...(flatMetadata ? ({ metadata: flatMetadata } as Record<string, unknown>) : {}),
      });
    if (error) {
      await auditClipUpload({
        path,
        file,
        outcome: "failed",
        errorMessage: error.message,
        details: { transport: "sdk", contentType, storageMetadata: flatMetadata, uploadedBy: userId },
      });
      return { ok: false, message: "Upload failed. Check your connection and try that clip again." };
    }
    transport = "sdk";
    onProgress?.({ loaded: file.size, total: file.size, percent: 100 });
  }


  // Sidecar JSON keeps the full analysis (including issue text) queryable even
  // where storage user-metadata is unavailable.
  let metadataPath: string | null = null;
  if (metadata && flatMetadata) {
    const sidecarPath = `${path}.meta.json`;
    const blob = new Blob([JSON.stringify({ ...metadata, ...flatMetadata, clipPath: path }, null, 2)], {
      type: "application/json",
    });
    const { error: metaError } = await supabase.storage
      .from(VOICE_SAMPLE_BUCKET)
      .upload(sidecarPath, blob, { upsert: true, contentType: "application/json" });
    if (!metaError) metadataPath = sidecarPath;
  }

  await auditClipUpload({
    path,
    file,
    outcome: "success",
    details: {
      transport,
      contentType,
      uploadedBy: userId,
      metadataPath,
      // The exact user-metadata payload written to storage, plus the full
      // trim/quality analysis stored in the .meta.json sidecar.
      storageMetadata: flatMetadata,
      sidecarMetadata: metadata ?? null,
    },
  });

  const { data: signed, error: signError } = await supabase.storage
    .from(VOICE_SAMPLE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_SECONDS);

  if (signError || !signed?.signedUrl) {
    return { ok: false, message: "Uploaded, but the clip link could not be created. Try again." };
  }

  return { ok: true, url: signed.signedUrl, name: file.name, path, metadataPath };
}
