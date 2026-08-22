/**
 * Server-only Hybrid Engine storage: mix/master finish uploads the playable
 * MP3 with createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 *
 * UI step labels live in `engine-pipeline.ts` (safe for the browser bundle).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  AUDIO_VAULT_BUCKET,
  STUDIO_AUDIO_BUCKET,
  vaultMimeType,
} from "@/lib/audio-vault";
import {
  backendServiceRoleKey,
  backendSupabaseUrl,
  isDevRuntime,
} from "@/lib/supabase-env.server";

const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

export function createEngineSupabaseClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || backendSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || backendServiceRoleKey();
  if (!url || !key) {
    console.warn(
      "[engine] Missing process.env.NEXT_PUBLIC_SUPABASE_URL or process.env.SUPABASE_SERVICE_ROLE_KEY",
    );
    return null;
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Stores the mastered MP3 in Supabase Storage (`audio-vault`, then
 * `studio-deliveries`). In development, falls back to `.data/local-vault` when
 * the service role key is missing or the upload is rejected.
 */
export async function uploadEngineMaster(
  bytes: Uint8Array,
  objectPath: string,
  fileType: "wav" | "mp3" = "mp3",
): Promise<string> {
  const client = createEngineSupabaseClient();
  const mimeType = vaultMimeType(fileType);
  if (client) {
    const buckets = [AUDIO_VAULT_BUCKET, STUDIO_AUDIO_BUCKET];
    let lastError: unknown = null;
    for (const bucket of buckets) {
      const { error } = await client.storage.from(bucket).upload(objectPath, bytes, {
        contentType: mimeType,
        upsert: true,
        cacheControl: "31536000",
      });
      if (error) {
        lastError = error;
        console.warn(`[engine] storage upload failed (${bucket})`, error.message);
        continue;
      }
      const { data, error: signError } = await client.storage
        .from(bucket)
        .createSignedUrl(objectPath, SIGNED_URL_TTL);
      if (!signError && data?.signedUrl) {
        console.log("[engine] mastered track uploaded", bucket, objectPath);
        return data.signedUrl;
      }
      lastError = signError ?? lastError;
    }
    if (!isDevRuntime()) {
      throw lastError instanceof Error
        ? lastError
        : new Error("The mastered track could not be saved to Supabase Storage.");
    }
    console.warn(
      "[engine] Supabase Storage unreachable — writing mastered MP3 to local vault",
      lastError instanceof Error ? lastError.message : lastError,
    );
  }

  const { saveLocalAudioFile } = await import("@/lib/local-vault.server");
  return saveLocalAudioFile(bytes, objectPath, fileType);
}

/**
 * Marks the generate as completed in Supabase the moment a playable master
 * URL exists. Writes `user_vault` and `studio_tracks`, and best-effort
 * `generation_tasks` (same contract: status + audio_url).
 */
export async function completeGenerationTask(input: {
  taskId?: string | null;
  userId: string;
  audioUrl: string;
}): Promise<void> {
  const taskId = input.taskId?.trim();
  const audioUrl = input.audioUrl.trim();
  if (!taskId || !audioUrl) return;
  const supabase = createEngineSupabaseClient();
  if (!supabase) {
    console.warn("[engine] completeGenerationTask skipped — no admin client");
    return;
  }
  const now = new Date().toISOString();

  const { error: vaultError } = await supabase
    .from("user_vault")
    .update({ status: "completed", master_url: audioUrl })
    .eq("id", taskId)
    .eq("user_id", input.userId);
  if (vaultError) {
    console.warn("[engine] user_vault completion update failed", vaultError.message);
  }

  const { error: studioError } = await supabase
    .from("studio_tracks")
    .update({
      audio_url: audioUrl,
      mastered_status: "ready",
      updated_at: now,
    })
    .eq("id", taskId)
    .eq("user_id", input.userId);
  if (studioError) {
    console.warn("[engine] studio_tracks completion update failed", studioError.message);
  }

  const taskClient = supabase as unknown as {
    from: (table: string) => {
      update: (values: Record<string, string>) => {
        eq: (column: string, value: string) => Promise<{ error: { message: string } | null }>;
      };
    };
  };
  const { error: taskError } = await taskClient.from("generation_tasks").update({
    status: "completed",
    audio_url: audioUrl,
    updated_at: now,
  }).eq("id", taskId);
  if (taskError && !/schema cache|does not exist|Could not find the table/i.test(taskError.message)) {
    console.warn("[engine] generation_tasks completion update failed", taskError.message);
  }
}
