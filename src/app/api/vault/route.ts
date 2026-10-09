import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { storageObjectFromUrl } from "@/lib/audio-vault";
import { resolveStudioSession, UnauthorizedSessionError } from "@/lib/studio-request-auth.server";

type VaultRow = {
  id?: string | null;
  task_id?: string | null;
  title?: string | null;
  prompt?: string | null;
  wav_url?: string | null;
  mp3_url?: string | null;
  user_id?: string | null;
};

function vaultClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    "";
  if (!url || !key) return null;
  return createClient(url, key);
}

/** Service role only. A vault delete must not run with the anon key. */
function vaultDeleteClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * GET /api/vault
 * Newest 20 vaulted_tracks for the bearer session user.
 * No valid bearer session: 401 and no rows. Client is created here so
 * importing this module does not throw when Supabase env is missing.
 */
export async function GET(req?: Request): Promise<Response> {
  try {
    return await readVault(req);
  } catch (err) {
    if (isUnauthorized(err)) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Supabase query failed";
    return Response.json({ error: message }, { status: 500 });
  }
}

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedSessionError) return true;
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  return name === "UnauthorizedSessionError" || status === 401;
}

/** Bearer session user. Empty when the caller is signed out or the token is missing. */
async function sessionUserId(req?: Request): Promise<string> {
  const header = req?.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || !header.slice("Bearer ".length).trim()) return "";
  const session = await resolveStudioSession(req as Request);
  return session.userId.trim();
}

async function readVault(req?: Request): Promise<Response> {
  const supabase = vaultClient();
  if (!supabase) {
    return Response.json({ error: "Supabase is not configured" }, { status: 500 });
  }

  const userId = await sessionUserId(req);
  // Service role bypasses RLS, so a missing session must not read the table.
  if (!userId) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }
  const { data, error } = await supabase
    .from("vaulted_tracks")
    .select("id, title, prompt, wav_url, mp3_url, created_at, user_id, task_id")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const tracks = ((data ?? []) as VaultRow[])
    .filter((row) => row.user_id === userId)
    .map((row) => ({
      id: row.id || row.task_id,
      title: row.title || "Untitled Master",
      genre: String(row.prompt || "").slice(0, 24),
      duration: "210s",
      status: "Ready",
      wav_url: resolvedAudioUrl(supabase, row.wav_url),
      mp3_url: resolvedAudioUrl(supabase, row.mp3_url),
    }));

  return Response.json({ tracks });
}

function resolvedAudioUrl(supabase: SupabaseClient, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.includes("/storage/v1/object/")) {
    if (text.startsWith("/")) {
      const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
      return base ? `${base}${text}` : text;
    }
    return text;
  }
  const path = text.replace(/^\/+/, "");
  if (!path || path.includes("..")) return null;
  const { data } = supabase.storage.from("audio-vault").getPublicUrl(path);
  return data.publicUrl || null;
}

function safeTaskId(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  if (!text || !/^[A-Za-z0-9_-]+$/.test(text)) return "";
  return text;
}

function audioVaultObjectPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.includes("..")) return null;
  if (/^https?:\/\//i.test(text) || text.includes("/storage/")) {
    const href = /^https?:\/\//i.test(text)
      ? text
      : `https://project.supabase.co${text.startsWith("/") ? text : `/${text}`}`;
    const object = storageObjectFromUrl(href);
    if (!object || object.bucket !== "audio-vault" || object.path.includes("..")) return null;
    return object.path.replace(/^\/+/, "");
  }
  const path = text.replace(/^\/+/, "");
  return path || null;
}

/** Storage removal is limited to this user's prefix or vocals/{taskId}.mp3. */
function ownedAudioVaultPath(value: unknown, userId: string, taskId: string): string | null {
  const path = audioVaultObjectPath(value);
  if (!path) return null;
  if (taskId && path === `vocals/${taskId}.mp3`) return path;
  if (path.startsWith(`${userId}/`) || path.includes(`/${userId}/`)) return path;
  return null;
}

type OwnedVaultRow = {
  id?: string | null;
  user_id?: string | null;
  task_id?: string | null;
  wav_url?: string | null;
  mp3_url?: string | null;
};

/**
 * DELETE /api/vault/:id
 * Bearer session required. Deletes vaulted_tracks where id and user_id match
 * that session. A body userId is ignored. Storage objects are removed only
 * when the path is under the session user's prefix or vocals/{taskId}.mp3.
 */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const userId = await sessionUserId(req);
    if (!userId) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    const url = new URL(req.url);
    const parts = url.pathname.replace(/\/$/, "").split("/");
    const last = decodeURIComponent(parts[parts.length - 1] ?? "").trim();
    const id = last === "vault" ? "" : last;
    if (!id) {
      return Response.json({ error: "Vault row id is required." }, { status: 400 });
    }
    const supabase = vaultDeleteClient();
    if (!supabase) {
      return Response.json({ error: "Supabase is not configured" }, { status: 500 });
    }
    const { data, error } = await supabase
      .from("vaulted_tracks")
      .select("id, user_id, task_id, wav_url, mp3_url")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    const row = (data ?? null) as OwnedVaultRow | null;
    if (!row?.id || row.user_id !== userId) {
      return Response.json({ error: "Vault track not found." }, { status: 404 });
    }
    const taskId = safeTaskId(row.task_id);
    const paths = [
      ...new Set(
        [ownedAudioVaultPath(row.wav_url, userId, taskId), ownedAudioVaultPath(row.mp3_url, userId, taskId)].filter(
          (path): path is string => Boolean(path),
        ),
      ),
    ];
    if (paths.length > 0) {
      const { error: removeError } = await supabase.storage.from("audio-vault").remove(paths);
      if (removeError) {
        console.error("[vault] storage remove failed");
      }
    }
    const { error: deleteError } = await supabase
      .from("vaulted_tracks")
      .delete()
      .eq("id", row.id)
      .eq("user_id", userId);
    if (deleteError) {
      return Response.json({ error: deleteError.message }, { status: 500 });
    }
    return Response.json({ success: true });
  } catch (err) {
    if (isUnauthorized(err)) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Supabase query failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
