/**
 * Shared (cross-instance) dedupe cache for the efficiency proxy.
 *
 * The in-memory map in `efficiency-proxy.server.ts` only dedupes within one
 * worker instance and dies on restart. This layer persists the same
 * fingerprint → result mapping in Supabase so a duplicate render brief is
 * recognised no matter which instance serves it, or how many times the worker
 * has been recycled since.
 *
 * Service-role only: the table has RLS on with no policies, so nothing but
 * trusted server code can read or write it. Every operation is best-effort —
 * a database hiccup must never block a render, it just costs a cache miss.
 */

const TABLE = "engine_proxy_cache";

type CacheRow = { value: unknown; expires_at: string };

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Reads a shared cache entry, or null when missing, expired, or unavailable. */
export async function readSharedProxyCache<T>(
  fingerprint: string,
  now = Date.now(),
): Promise<T | null> {
  try {
    const db = await admin();
    const { data, error } = await db
      .from(TABLE)
      .select("value, expires_at")
      .eq("fingerprint", fingerprint)
      .maybeSingle<CacheRow>();
    if (error || !data) return null;
    if (new Date(data.expires_at).getTime() <= now) return null;
    return data.value as T;
  } catch {
    return null;
  }
}

/** Upserts a shared cache entry. Never throws. */
export async function writeSharedProxyCache(
  fingerprint: string,
  value: unknown,
  expiresAt: number,
): Promise<void> {
  try {
    const db = await admin();
    await db.from(TABLE).upsert(
      {
        fingerprint,
        value: value as never,
        expires_at: new Date(expiresAt).toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "fingerprint" },
    );
  } catch {
    /* cache writes are best effort */
  }
}

/** Drops expired rows so the table stays small. Never throws. */
export async function purgeSharedProxyCache(now = Date.now()): Promise<void> {
  try {
    const db = await admin();
    await db.from(TABLE).delete().lt("expires_at", new Date(now).toISOString());
  } catch {
    /* best effort */
  }
}

/** Test/ops helper: empties the shared cache. */
export async function clearSharedProxyCache(): Promise<void> {
  try {
    const db = await admin();
    await db.from(TABLE).delete().neq("fingerprint", "");
  } catch {
    /* best effort */
  }
}
