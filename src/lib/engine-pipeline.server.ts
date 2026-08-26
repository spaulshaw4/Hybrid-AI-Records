/**
 * Server-only Hybrid Engine storage: mix/master finish uploads the playable
 * MP3 with createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 *
 * UI step labels live in `engine-pipeline.ts` (safe for the browser bundle).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { tryGetSupabaseAdmin } from "@/integrations/supabase/client.server";
import {
  AUDIO_VAULT_BUCKET,
  STUDIO_AUDIO_BUCKET,
} from "@/lib/audio-vault";
import {
  backendServiceRoleKey,
  backendSupabaseUrl,
  isDevRuntime,
} from "@/lib/supabase-env.server";

const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

export function createEngineSupabaseClient(): SupabaseClient | null {
  // Prefer the shared service-role singleton (custom fetch + auth flags).
  const admin = tryGetSupabaseAdmin();
  if (admin) return admin;

  const url =
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    backendSupabaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || backendServiceRoleKey();
  if (!url || !key) {
    console.warn("[engine] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY for vault upload");
    return null;
  }
  return createClient(url, key, {
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
  // Explicit Content-Type: masters → audio/wav, raw/playable MPEG → audio/mpeg.
  const mimeType: "audio/wav" | "audio/mpeg" =
    fileType === "wav" ? "audio/wav" : "audio/mpeg";
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

const VAULT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function asVaultUuid(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && VAULT_UUID_RE.test(trimmed) ? trimmed : null;
}

/**
 * Marks the generate as completed in Supabase the moment a playable master
 * URL exists. Upserts `user_vault` (service role) and best-effort patches
 * `studio_tracks` / `generation_tasks` when ids are real UUIDs.
 *
 * Prefer `vaultId` (client-opened `user_vault` row). MusicAPI `taskId` values
 * are often not UUIDs and must not be used as `user_vault.id`.
 */
export async function completeGenerationTask(input: {
  taskId?: string | null;
  /** Client / pipeline vault row id — preferred key for `user_vault`. */
  vaultId?: string | null;
  userId: string;
  audioUrl: string;
  title?: string | null;
  style?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  rawAudioUrl?: string | null;
}): Promise<void> {
  const audioUrl = input.audioUrl.trim();
  if (!audioUrl) return;
  const supabase = createEngineSupabaseClient();
  if (!supabase) {
    console.warn("[engine] completeGenerationTask skipped — no admin client");
    return;
  }
  const now = new Date().toISOString();
  const vaultRowId = asVaultUuid(input.vaultId) ?? asVaultUuid(input.taskId);

  // Canonical user_vault write — service role + FK-safe owner via persistUserVault.
  try {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    await persistUserVault(supabase, input.userId, {
      id: vaultRowId ?? undefined,
      title: input.title?.trim() || "Untitled Track",
      style: input.style?.trim() || null,
      status: "completed",
      masterUrl: audioUrl,
      instrumentalUrl: input.instrumentalUrl,
      vocalUrl: input.vocalUrl,
      rawAudioUrl: input.rawAudioUrl,
      tokensUsed: 1,
    });
  } catch (error) {
    console.error(
      "[engine] user_vault completion persist failed",
      error instanceof Error ? error.message : error,
    );
  }

  const studioId = vaultRowId ?? asVaultUuid(input.taskId);
  if (studioId) {
    const { error: studioError } = await supabase
      .from("studio_tracks")
      .update({
        audio_url: audioUrl,
        mastered_status: "ready",
        updated_at: now,
      })
      .eq("id", studioId)
      .eq("user_id", input.userId);
    if (studioError) {
      console.warn("[engine] studio_tracks completion update failed", studioError.message);
    }

    const { error: taskError } = await supabase
      .from("generation_tasks")
      .upsert(
        {
          id: studioId,
          user_id: input.userId,
          status: "completed",
          audio_url: audioUrl,
          updated_at: now,
        } as never,
        { onConflict: "id" },
      );
    if (taskError) {
      console.warn("[engine] generation_tasks completion upsert failed", taskError.message);
    }
  }
}

/**
 * Marks a render failed so a halted pipeline does not leave the row claiming it
 * is still processing. Best-effort: a bookkeeping miss must not mask the real
 * generate error the artist is being shown.
 */
export async function failGenerationTask(input: {
  taskId?: string | null;
  vaultId?: string | null;
  userId: string;
  reason: string;
}): Promise<void> {
  const rowId = asVaultUuid(input.vaultId) ?? asVaultUuid(input.taskId);
  if (!rowId) {
    console.warn("[engine] failGenerationTask skipped — no UUID vault/task id", {
      taskId: input.taskId,
      vaultId: input.vaultId,
    });
    return;
  }
  const supabase = createEngineSupabaseClient();
  if (!supabase) {
    console.warn("[engine] failGenerationTask skipped — no admin client");
    return;
  }
  const now = new Date().toISOString();
  console.error("[GATE_FAIL] marking render failed", { taskId: rowId, reason: input.reason });

  const { error: taskError } = await supabase
    .from("generation_tasks")
    .update({ status: "failed", updated_at: now })
    .eq("id", rowId);
  if (taskError) {
    console.warn("[engine] generation_tasks failure update failed", taskError.message);
  }

  // Never overwrite a row that already has a playable master — persistUserVault
  // keeps completed when master_url is already set.
  try {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    await persistUserVault(supabase, input.userId, {
      id: rowId,
      status: "failed",
    });
  } catch (error) {
    console.warn(
      "[engine] user_vault failure update failed",
      error instanceof Error ? error.message : error,
    );
  }

  const { error: studioError } = await supabase
    .from("studio_tracks")
    .update({ mastered_status: "failed", updated_at: now })
    .eq("id", rowId)
    .eq("user_id", input.userId);
  if (studioError) {
    console.warn("[engine] studio_tracks failure update failed", studioError.message);
  }
}
