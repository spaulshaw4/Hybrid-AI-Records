import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sanitizeVaultTracks } from "@/lib/vault-tracks";

export type UserVaultStatus = "processing" | "completed" | "failed";

export type UserVaultStems = {
  id?: string;
  title: string;
  style?: string | null;
  status: UserVaultStatus;
  masterUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  /** Raw Gate 1 engine audio, before stems and mastering. */
  rawAudioUrl?: string | null;
  /** Hybrid Tokens charged for this generation. */
  tokensUsed?: number | null;
};

/** Wire JSON shape for GET /api/studio/vault/tracks */
export type UserVaultApiTrack = {
  id: string;
  title: string;
  style: string;
  status: UserVaultStatus;
  master_url: string | null;
  instrumental_url: string | null;
  vocal_url: string | null;
  raw_audio_url: string | null;
  created_at: string;
  artist_name: string;
  album_name: string;
};

export function asVaultStatus(value: string | null | undefined): UserVaultStatus {
  if (value === "completed" || value === "failed" || value === "processing") return value;
  return "processing";
}

/** Opens or finishes a vault row. Never throws — a vault miss must not fail the render. */
export async function persistUserVault(
  supabase: SupabaseClient<Database>,
  userId: string,
  stems: UserVaultStems,
): Promise<string | null> {
  const masterUrl = stems.masterUrl?.trim() || null;
  // A playable master always wins. Never write a phantom `failed` over audio
  // that already landed, and never null out an existing master_url.
  let status: UserVaultStatus = masterUrl ? "completed" : stems.status;
  const patch: {
    user_id: string;
    title: string;
    style: string | null;
    status: UserVaultStatus;
    master_url?: string | null;
    instrumental_url?: string | null;
    vocal_url?: string | null;
    raw_audio_url?: string | null;
    tokens_used?: number;
  } = {
    user_id: userId,
    title: stems.title.trim() || "Untitled Track",
    style: stems.style?.trim() || null,
    status,
  };
  if (masterUrl) patch.master_url = masterUrl;
  if (stems.instrumentalUrl) patch.instrumental_url = stems.instrumentalUrl;
  if (stems.vocalUrl) patch.vocal_url = stems.vocalUrl;
  if (stems.rawAudioUrl) patch.raw_audio_url = stems.rawAudioUrl;
  if (typeof stems.tokensUsed === "number" && Number.isFinite(stems.tokensUsed)) {
    patch.tokens_used = Math.max(0, Math.min(100, Math.round(stems.tokensUsed)));
  }

  if (stems.id) {
    if (!masterUrl && stems.status === "failed") {
      const { data: existing } = await supabase
        .from("user_vault")
        .select("master_url")
        .eq("id", stems.id)
        .eq("user_id", userId)
        .maybeSingle();
      if (existing?.master_url) {
        status = "completed";
        patch.status = "completed";
        patch.master_url = existing.master_url;
      }
    }
    const { error } = await supabase
      .from("user_vault")
      .update(patch)
      .eq("id", stems.id)
      .eq("user_id", userId);
    if (error) {
      console.warn("[user_vault] update failed", error.message);
      return stems.id;
    }
    if (status === "completed") {
      const audioUrl = masterUrl || patch.master_url || null;
      if (audioUrl) {
        try {
          const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
          await completeGenerationTask({
            taskId: stems.id,
            userId,
            audioUrl,
          });
        } catch (error) {
          console.warn(
            "[user_vault] completion sync skipped",
            error instanceof Error ? error.message : error,
          );
        }
      }
    }
    return stems.id;
  }

  const insertRow = {
    ...patch,
    master_url: masterUrl,
    instrumental_url: stems.instrumentalUrl || null,
    vocal_url: stems.vocalUrl || null,
    raw_audio_url: stems.rawAudioUrl || null,
    tokens_used:
      typeof stems.tokensUsed === "number" && Number.isFinite(stems.tokensUsed)
        ? Math.max(0, Math.min(100, Math.round(stems.tokensUsed)))
        : masterUrl
          ? 1
          : 0,
  };
  const { data, error } = await supabase
    .from("user_vault")
    .insert(insertRow)
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn("[user_vault] insert failed", error.message);
    return null;
  }
  const id = data?.id ?? null;
  if (id && masterUrl) {
    try {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({ taskId: id, userId, audioUrl: masterUrl });
    } catch (error) {
      console.warn(
        "[user_vault] completion sync skipped",
        error instanceof Error ? error.message : error,
      );
    }
  }
  return id;
}

async function toApiTracks(
  rows: Array<Record<string, unknown>>,
): Promise<UserVaultApiTrack[]> {
  let signed = new Map<string, string>();
  try {
    const { signedUrlsForStored } = await import("@/lib/track-refresh.server");
    signed = await signedUrlsForStored(
      rows.flatMap((row) => [
        typeof row.master_url === "string" ? row.master_url : null,
        typeof row.instrumental_url === "string" ? row.instrumental_url : null,
        typeof row.vocal_url === "string" ? row.vocal_url : null,
        typeof row.raw_audio_url === "string" ? row.raw_audio_url : null,
      ]),
    );
  } catch (error) {
    console.warn(
      "[user_vault] signed URL refresh skipped",
      error instanceof Error ? error.message : error,
    );
  }
  const resolve = (url: unknown) =>
    typeof url === "string" && url ? (signed.get(url) ?? url) : null;
  return sanitizeVaultTracks(
    rows.map((row) => ({
      ...row,
      id: row.id,
      title: row.title || "Untitled Generation",
      style: row.style || "Custom",
      status: asVaultStatus(typeof row.status === "string" ? row.status : null),
      master_url: resolve(row.master_url),
      instrumental_url: resolve(row.instrumental_url),
      vocal_url: resolve(row.vocal_url),
      raw_audio_url: resolve(row.raw_audio_url ?? null),
      created_at: row.created_at,
    })),
  );
}

const VAULT_SELECT_WITH_RELATIONS = "*, album:albums(*), artist:artists(*)";
const VAULT_SELECT_FLAT =
  "id, title, style, status, master_url, instrumental_url, vocal_url, raw_audio_url, tokens_used, created_at, artist_name, album_name, artist_id, album_id";

export async function listUserVaultApiTracks(userId: string): Promise<UserVaultApiTrack[]> {
  let remote: UserVaultApiTrack[] = [];
  try {
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (admin) {
      let data: unknown[] | null = null;
      let error: { message: string } | null = null;

      const joined = await admin
        .from("user_vault")
        .select(VAULT_SELECT_WITH_RELATIONS)
        .eq("user_id", userId)
        .or("status.eq.completed,status.eq.processing,master_url.not.is.null")
        .order("created_at", { ascending: false });

      if (joined.error) {
        console.warn(
          "[user_vault] relation join unavailable — falling back to flat select:",
          joined.error.message,
        );
        const flat = await admin
          .from("user_vault")
          .select(VAULT_SELECT_FLAT)
          .eq("user_id", userId)
          .or("status.eq.completed,status.eq.processing,master_url.not.is.null")
          .order("created_at", { ascending: false });
        data = flat.data;
        error = flat.error;
      } else {
        data = joined.data;
      }

      if (error) {
        console.warn("[user_vault] list failed", error.message);
      } else {
        remote = await toApiTracks((data ?? []) as Array<Record<string, unknown>>);
      }
    }
  } catch (error) {
    console.warn(
      "[user_vault] list failed",
      error instanceof Error ? error.message : error,
    );
  }
  try {
    const { listLocalVaultTracks } = await import("@/lib/local-vault.server");
    const local = await listLocalVaultTracks();
    const ids = new Set(remote.map((row) => row.id));
    return sanitizeVaultTracks([...local.filter((row) => !ids.has(row.id)), ...remote]);
  } catch {
    return remote;
  }
}

export async function getUserVaultApiTrack(
  userId: string,
  trackId: string,
): Promise<UserVaultApiTrack | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("user_vault")
      .select(VAULT_SELECT_WITH_RELATIONS)
      .eq("user_id", userId)
      .eq("id", trackId)
      .maybeSingle();
    if (error) {
      // Relation join may be unavailable before migration — retry flat.
      const flat = await supabaseAdmin
        .from("user_vault")
        .select(VAULT_SELECT_FLAT)
        .eq("user_id", userId)
        .eq("id", trackId)
        .maybeSingle();
      if (flat.error) {
        console.warn("[user_vault] get failed", flat.error.message);
        return null;
      }
      if (!flat.data) return null;
      const [track] = await toApiTracks([flat.data as Record<string, unknown>]);
      return track ?? null;
    }
    if (!data) return null;
    const [track] = await toApiTracks([data as Record<string, unknown>]);
    return track ?? null;
  } catch (error) {
    console.warn(
      "[user_vault] get failed",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

export async function deleteUserVaultApiTrack(userId: string, trackId: string): Promise<boolean> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: row } = await supabaseAdmin
    .from("user_vault")
    .select("master_url, instrumental_url, vocal_url")
    .eq("id", trackId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return false;

  const {
    storageObjectFromUrl,
    STUDIO_AUDIO_BUCKET,
    AUDIO_VAULT_BUCKET,
  } = await import("@/lib/track-refresh.server");
  const { vaultMasterObjectPath, vaultStemObjectPath } = await import("@/lib/audio-vault");

  const byBucket = new Map<string, Set<string>>();
  const add = (bucket: string, path: string) => {
    const set = byBucket.get(bucket) ?? new Set<string>();
    set.add(path);
    byBucket.set(bucket, set);
  };

  for (const url of [row.master_url, row.instrumental_url, row.vocal_url]) {
    if (!url) continue;
    const object = storageObjectFromUrl(url);
    if (object) add(object.bucket, object.path);
  }

  for (const ext of ["mp3", "wav", "flac"] as const) {
    add(AUDIO_VAULT_BUCKET, vaultMasterObjectPath(trackId, ext));
    add(AUDIO_VAULT_BUCKET, vaultStemObjectPath(trackId, "vocal", ext));
    add(AUDIO_VAULT_BUCKET, vaultStemObjectPath(trackId, "instrumental", ext));
  }
  add(STUDIO_AUDIO_BUCKET, `${userId}/${trackId}_master.mp3`);
  add(STUDIO_AUDIO_BUCKET, `${userId}/${trackId}.mp3`);

  const { error } = await supabaseAdmin
    .from("user_vault")
    .delete()
    .eq("id", trackId)
    .eq("user_id", userId);
  if (error) throw new Error("Deletion failed on server");

  await Promise.all(
    [...byBucket.entries()].map(([bucket, paths]) =>
      paths.size ? supabaseAdmin.storage.from(bucket).remove([...paths]) : Promise.resolve(),
    ),
  );
  return true;
}
