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

function mastersPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.includes("..")) return null;
  if (/^https?:\/\//i.test(text) || text.includes("/storage/")) {
    const href = /^https?:\/\//i.test(text)
      ? text
      : `https://project.supabase.co${text.startsWith("/") ? text : `/${text}`}`;
    const object = storageObjectFromUrl(href);
    if (!object || object.bucket !== "audio-vault" || !object.path.startsWith("masters/")) return null;
    return object.path;
  }
  const path = text.replace(/^\/+/, "");
  return path.startsWith("masters/") ? path : null;
}

/**
 * DELETE /api/vault/:id
 * Removes audio-vault masters named on that vaulted_tracks row, then the row.
 */
export async function DELETE(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parts = url.pathname.replace(/\/$/, "").split("/");
    const last = decodeURIComponent(parts[parts.length - 1] ?? "").trim();
    const id = last === "vault" ? "" : last;
    if (!id) {
      return Response.json({ error: "Vault row id is required." }, { status: 400 });
    }
    const supabase = vaultClient();
    if (!supabase) {
      return Response.json({ error: "Supabase is not configured" }, { status: 500 });
    }
    const { data, error } = await supabase
      .from("vaulted_tracks")
      .select("id, wav_url, mp3_url")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data?.id) {
      return Response.json({ error: "Vault track not found." }, { status: 404 });
    }
    const paths = [...new Set([mastersPath(data.wav_url), mastersPath(data.mp3_url)].filter((path): path is string => Boolean(path)))];
    if (paths.length > 0) {
      const { error: removeError } = await supabase.storage.from("audio-vault").remove(paths);
      if (removeError) {
        return Response.json({ error: removeError.message }, { status: 500 });
      }
    }
    const { error: deleteError } = await supabase.from("vaulted_tracks").delete().eq("id", data.id);
    if (deleteError) {
      return Response.json({ error: deleteError.message }, { status: 500 });
    }
    return Response.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Supabase query failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
