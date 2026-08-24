/**
 * Ensure the Gate 2 / master vault Storage bucket exists (service role).
 * Creates a public bucket so Replicate can fetch Gate 2 CDN URLs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AUDIO_VAULT_BUCKET,
  AUDIO_VAULT_MAX_BYTES,
  AUDIO_VAULT_MIME_TYPES,
  resolveAudioVaultBucket,
} from "@/lib/audio-vault";

const ensured = new Set<string>();

export async function ensureAudioVaultBucket(
  supabaseAdmin: SupabaseClient,
  bucketName: string = resolveAudioVaultBucket() || AUDIO_VAULT_BUCKET,
): Promise<string> {
  const bucket = bucketName.trim() || AUDIO_VAULT_BUCKET;
  if (ensured.has(bucket)) return bucket;

  const { data: existing, error: listError } = await supabaseAdmin.storage.listBuckets();
  if (listError) {
    console.error("[audio-vault] listBuckets failed:", listError.message);
    // Do not cache — next call may succeed; let upload surface the real error.
    return bucket;
  }

  const found = (existing ?? []).find((row) => row.id === bucket || row.name === bucket);
  if (found) {
    console.log(
      `[audio-vault] bucket ready: ${bucket} (public=${Boolean(found.public)})`,
    );
    if (!found.public) {
      const { error: updateError } = await supabaseAdmin.storage.updateBucket(bucket, {
        public: true,
      });
      if (updateError) {
        console.warn(
          `[audio-vault] could not set public=true on "${bucket}":`,
          updateError.message,
        );
      } else {
        console.log(`[audio-vault] updated "${bucket}" to public=true for Gate 2 CDN`);
      }
    }
    ensured.add(bucket);
    return bucket;
  }

  console.warn(`[audio-vault] bucket "${bucket}" missing — creating (public)…`);
  const { error: createError } = await supabaseAdmin.storage.createBucket(bucket, {
    public: true,
    fileSizeLimit: AUDIO_VAULT_MAX_BYTES,
    allowedMimeTypes: [...AUDIO_VAULT_MIME_TYPES],
  });
  if (createError && !/already exists|duplicate/i.test(createError.message)) {
    console.error("[audio-vault] createBucket failed:", createError.message);
    throw new Error(
      `Gate 2 storage bucket "${bucket}" is missing and could not be created: ${createError.message}`,
    );
  }
  console.log(`[audio-vault] created bucket "${bucket}"`);
  ensured.add(bucket);
  return bucket;
}
