import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { sanitizeVaultTracks } from "@/lib/vault-tracks";
import { randomUUID } from "node:crypto";

export type UserVaultStatus = "processing" | "completed" | "failed";

export type UserVaultStems = {
  id?: string;
  /** When omitted on update, existing title is preserved. */
  title?: string;
  style?: string | null;
  status: UserVaultStatus;
  masterUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  /** Raw Gate 1 engine audio, before stems and mastering. */
  rawAudioUrl?: string | null;
  /** Upstream MusicAPI / AIMusicAPI task id (often non-UUID). */
  providerTaskId?: string | null;
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type VaultWriteError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

/** `user_vault.id` / `generation_tasks.id` are uuid — MusicAPI task ids often are not. */
export function isUserVaultUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID_RE.test(value.trim());
}

export function asVaultStatus(value: string | null | undefined): UserVaultStatus {
  if (value === "completed" || value === "failed" || value === "processing") return value;
  return "processing";
}

function isForeignKeyError(error: VaultWriteError | null | undefined): boolean {
  if (!error) return false;
  return (
    error.code === "23503" ||
    /foreign key|auth\.users/i.test(error.message ?? "") ||
    /foreign key|auth\.users/i.test(error.details ?? "")
  );
}

function isMissingColumnError(error: VaultWriteError | null | undefined): boolean {
  if (!error) return false;
  return /schema cache|Could not find the .* column|column .* does not exist/i.test(
    error.message ?? "",
  );
}

/**
 * Resolves a service-role client so RLS cannot block vault writes.
 * Falls back to the caller-supplied client only when credentials are absent.
 */
async function resolveVaultWriteClient(
  fallback: SupabaseClient<Database>,
): Promise<{ db: SupabaseClient<Database>; usedServiceRole: boolean }> {
  try {
    const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = tryGetSupabaseAdmin();
    if (admin) return { db: admin, usedServiceRole: true };
  } catch (error) {
    console.warn(
      "[user_vault] service-role client unavailable",
      error instanceof Error ? error.message : error,
    );
  }
  console.warn(
    "[user_vault] SUPABASE_SERVICE_ROLE_KEY missing — falling back to request client (RLS may block writes)",
  );
  return { db: fallback, usedServiceRole: false };
}

/**
 * Ensures `user_id` exists in `auth.users` so the user_vault FK cannot fail.
 * Auto-creates only the known local-dev test UUID (not real user ids).
 */
export async function ensureVaultAuthUser(
  db: SupabaseClient<Database>,
  userId: string,
): Promise<boolean> {
  if (!isUserVaultUuid(userId)) return false;

  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    if (!error && data?.user?.id) return true;
  } catch {
    /* admin API may be unavailable on the fallback client */
  }

  try {
    const { DEV_TEST_USER, DEV_TEST_USER_UUID } = await import("@/lib/dev-auth");
    if (userId !== DEV_TEST_USER_UUID) {
      console.error(
        "[Vault Save Error]: user_id is not present in auth.users — FK will reject the write",
        { userId },
      );
      return false;
    }

    const { error: createError } = await db.auth.admin.createUser({
      id: DEV_TEST_USER_UUID,
      email: DEV_TEST_USER.email,
      email_confirm: true,
      user_metadata: { full_name: "Hybrid Dev Test", vault_seed: true },
      app_metadata: { provider: "vault-ensure", role: "dev-test" },
    });

    if (createError && !/already|registered|exists|duplicate/i.test(createError.message)) {
      console.error(
        "[Vault Save Error]: failed to seed DEV_TEST_USER in auth.users",
        JSON.stringify(createError, null, 2),
      );
      return false;
    }
    console.log("[user_vault] seeded DEV_TEST_USER in auth.users for FK-safe vault writes");
    return true;
  } catch (error) {
    console.error(
      "[Vault Save Error]: ensureVaultAuthUser threw",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

function buildInsertRow(
  trackId: string,
  userId: string,
  stems: UserVaultStems,
  status: UserVaultStatus,
  masterUrl: string | null,
  options?: { omitOptionalColumns?: boolean },
): Database["public"]["Tables"]["user_vault"]["Insert"] {
  const title = stems.title?.trim() || "Untitled Track";
  const style = stems.style?.trim() || null;
  const providerTaskId = stems.providerTaskId?.trim() || null;
  const tokensUsed =
    typeof stems.tokensUsed === "number" && Number.isFinite(stems.tokensUsed)
      ? Math.max(0, Math.min(100, Math.round(stems.tokensUsed)))
      : masterUrl
        ? 1
        : 0;

  const row: Database["public"]["Tables"]["user_vault"]["Insert"] = {
    id: trackId,
    user_id: userId,
    title,
    style,
    status,
    master_url: masterUrl,
    instrumental_url: stems.instrumentalUrl?.trim() || null,
    vocal_url: stems.vocalUrl?.trim() || null,
  };

  if (!options?.omitOptionalColumns) {
    row.raw_audio_url = stems.rawAudioUrl?.trim() || null;
    row.provider_task_id = providerTaskId;
    row.tokens_used = tokensUsed;
  }

  return row;
}

function buildPatch(
  userId: string,
  stems: UserVaultStems,
  status: UserVaultStatus,
  masterUrl: string | null,
  options?: { omitOptionalColumns?: boolean },
): Record<string, unknown> {
  const style = stems.style?.trim() || null;
  const providerTaskId = stems.providerTaskId?.trim() || null;
  const tokensUsed =
    typeof stems.tokensUsed === "number" && Number.isFinite(stems.tokensUsed)
      ? Math.max(0, Math.min(100, Math.round(stems.tokensUsed)))
      : masterUrl
        ? 1
        : undefined;

  const patch: Record<string, unknown> = {
    user_id: userId,
    status,
  };
  if (typeof stems.title === "string" && stems.title.trim()) {
    patch.title = stems.title.trim();
  }
  if (style) patch.style = style;
  if (masterUrl) patch.master_url = masterUrl;
  if (stems.instrumentalUrl) patch.instrumental_url = stems.instrumentalUrl.trim();
  if (stems.vocalUrl) patch.vocal_url = stems.vocalUrl.trim();

  if (!options?.omitOptionalColumns) {
    if (stems.rawAudioUrl) patch.raw_audio_url = stems.rawAudioUrl.trim();
    if (providerTaskId) patch.provider_task_id = providerTaskId;
    if (typeof tokensUsed === "number") patch.tokens_used = tokensUsed;
  }

  return patch;
}

/**
 * Opens or finishes a vault row via service-role upsert (bypasses RLS).
 * Throws on hard DB failures so callers/SSE surfaces the real error.
 * Returns the confirmed `user_vault.id`.
 */
export async function persistUserVault(
  supabase: SupabaseClient<Database>,
  userId: string,
  stems: UserVaultStems,
): Promise<string | null> {
  const ownerId = userId?.trim();
  if (!ownerId || !isUserVaultUuid(ownerId)) {
    const message = `Failed to save to user_vault: invalid user_id (${ownerId || "empty"})`;
    console.error("[Vault Save Error]:", message);
    throw new Error(message);
  }

  const { db, usedServiceRole } = await resolveVaultWriteClient(supabase);
  if (usedServiceRole) {
    await ensureVaultAuthUser(db, ownerId);
  }

  const masterUrl = stems.masterUrl?.trim() || null;
  // A playable master always wins. Never write a phantom `failed` over audio
  // that already landed, and never null out an existing master_url.
  let status: UserVaultStatus = masterUrl ? "completed" : stems.status;
  const trackId = isUserVaultUuid(stems.id) ? stems.id!.trim() : randomUUID();

  console.log("Writing track to vault:", trackId);

  if (!masterUrl && stems.status === "failed" && isUserVaultUuid(stems.id)) {
    const { data: existing } = await db
      .from("user_vault")
      .select("master_url")
      .eq("id", stems.id!)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (existing?.master_url) {
      status = "completed";
    }
  }

  const writeOnce = async (omitOptionalColumns: boolean) => {
    if (isUserVaultUuid(stems.id)) {
      const patch = buildPatch(ownerId, stems, status, masterUrl, { omitOptionalColumns });
      const { data: updated, error: updateError } = await db
        .from("user_vault")
        .update(patch as never)
        .eq("id", trackId)
        .eq("user_id", ownerId)
        .select("id, master_url, status")
        .maybeSingle();

      if (updateError) {
        return { data: null as { id: string; master_url: string | null; status: string } | null, error: updateError };
      }
      if (updated?.id) {
        return { data: updated, error: null };
      }
      console.warn("[user_vault] update matched 0 rows — upserting", trackId);
    }

    const insertRow = buildInsertRow(trackId, ownerId, stems, status, masterUrl, {
      omitOptionalColumns,
    });
    return db
      .from("user_vault")
      .upsert(insertRow, { onConflict: "id" })
      .select("id, master_url, status")
      .maybeSingle();
  };

  try {
    let { data, error } = await writeOnce(false);

    if (error && isMissingColumnError(error)) {
      console.warn(
        "[user_vault] optional column missing — retrying core columns only",
        error.message,
      );
      ({ data, error } = await writeOnce(true));
    }

    if (error && isForeignKeyError(error)) {
      console.warn("[user_vault] FK violation — ensuring auth user and retrying", {
        userId: ownerId,
        message: error.message,
        code: error.code,
      });
      const ok = await ensureVaultAuthUser(db, ownerId);
      if (ok) {
        ({ data, error } = await writeOnce(false));
        if (error && isMissingColumnError(error)) {
          ({ data, error } = await writeOnce(true));
        }
      }
    }

    if (error) {
      console.error("[Vault Save Error]:", JSON.stringify(error, null, 2));
      throw new Error(`Failed to save to user_vault: ${error.message}`);
    }

    const id = data?.id ?? trackId;
    console.log("[Vault Save Success]: Track ID saved ->", data ?? { id, status, master_url: masterUrl });
    console.log("[user_vault] write committed", {
      trackId: id,
      status: data?.status ?? status,
      hasMaster: Boolean(data?.master_url ?? masterUrl),
      usedServiceRole,
    });
    return id;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Failed to save to user_vault:")) {
      throw error;
    }
    console.error(
      "[Vault Save Error]:",
      JSON.stringify(
        {
          trackId,
          userId: ownerId,
          message: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    );
    throw error instanceof Error
      ? error
      : new Error(`Failed to save to user_vault: ${String(error)}`);
  }
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
