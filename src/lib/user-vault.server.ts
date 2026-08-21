import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export type UserVaultStatus = "processing" | "completed" | "failed";

export type UserVaultStems = {
  id?: string;
  title: string;
  style?: string | null;
  status: UserVaultStatus;
  masterUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
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
  created_at: string;
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
  const row = {
    user_id: userId,
    title: stems.title.trim() || "Untitled Track",
    style: stems.style?.trim() || null,
    status: stems.status,
    master_url: stems.masterUrl || null,
    instrumental_url: stems.instrumentalUrl || null,
    vocal_url: stems.vocalUrl || null,
  };

  if (stems.id) {
    const { error } = await supabase
      .from("user_vault")
      .update(row)
      .eq("id", stems.id)
      .eq("user_id", userId);
    if (error) {
      console.warn("[user_vault] update failed", error.message);
      return stems.id;
    }
    return stems.id;
  }

  const { data, error } = await supabase
    .from("user_vault")
    .insert(row)
    .select("id")
    .maybeSingle();
  if (error) {
    console.warn("[user_vault] insert failed", error.message);
    return null;
  }
  return data?.id ?? null;
}

async function toApiTracks(
  rows: Array<{
    id: string;
    title: string | null;
    style: string | null;
    status: string | null;
    master_url: string | null;
    instrumental_url: string | null;
    vocal_url: string | null;
    created_at: string;
  }>,
): Promise<UserVaultApiTrack[]> {
  const { signedUrlsForStored } = await import("@/lib/track-refresh.server");
  const signed = await signedUrlsForStored(
    rows.flatMap((row) => [row.master_url, row.instrumental_url, row.vocal_url]),
  );
  const resolve = (url: string | null) => (url ? (signed.get(url) ?? url) : null);
  return rows.map((row) => ({
    id: row.id,
    title: row.title || "Untitled Generation",
    style: row.style || "Custom",
    status: asVaultStatus(row.status),
    master_url: resolve(row.master_url),
    instrumental_url: resolve(row.instrumental_url),
    vocal_url: resolve(row.vocal_url),
    created_at: row.created_at,
  }));
}

export async function listUserVaultApiTracks(userId: string): Promise<UserVaultApiTrack[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_vault")
    .select("id, title, style, status, master_url, instrumental_url, vocal_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error("Failed to load vault items");

  return toApiTracks(data ?? []);
}

export async function getUserVaultApiTrack(
  userId: string,
  trackId: string,
): Promise<UserVaultApiTrack | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("user_vault")
    .select("id, title, style, status, master_url, instrumental_url, vocal_url, created_at")
    .eq("user_id", userId)
    .eq("id", trackId)
    .maybeSingle();
  if (error) throw new Error("Failed to load vault item");
  if (!data) return null;
  const [track] = await toApiTracks([data]);
  return track ?? null;
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
