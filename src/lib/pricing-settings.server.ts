import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import {
  DEFAULT_SURCHARGE_BPS,
  applySurchargeBps,
  currentSurchargeBps,
  normalizeSurchargeBps,
  type CurrencyCode,
} from "@/lib/pricing";

const SETTINGS_KEY = "surcharge";
/** Short cache so a checkout burst doesn't hit the database per line item. */
const CACHE_MS = 30_000;

type Cached = { rates: Record<CurrencyCode, number>; updatedAt: string | null; at: number };
let cache: Cached | null = null;

function publicClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.");
  }
  return createClient<Database>(url, key, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Reads the admin-configured surcharge rates and applies them to the shared
 * pricing table, so every helper in `@/lib/pricing` quotes the live values.
 * Falls back to the built-in defaults whenever the row or the database is
 * unavailable — checkout must never stall on a settings read.
 */
export async function readSurchargeSettings(): Promise<{
  rates: Record<CurrencyCode, number>;
  updatedAt: string | null;
}> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    applySurchargeBps(cache.rates);
    return { rates: cache.rates, updatedAt: cache.updatedAt };
  }

  try {
    const { data, error } = await publicClient()
      // Public view: exposes only the safe pricing columns, never the admin identity.
      .from("pricing_settings_public")
      .select("surcharge_bps, updated_at")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();
    if (error) throw new Error(error.message);

    applySurchargeBps((data?.surcharge_bps as Record<string, unknown>) ?? null);
    const rates = currentSurchargeBps();
    cache = { rates, updatedAt: (data?.updated_at as string | null) ?? null, at: Date.now() };
    return { rates, updatedAt: cache.updatedAt };
  } catch (err) {
    console.error("Surcharge settings read failed:", (err as Error).message);
    applySurchargeBps(null);
    return { rates: { ...DEFAULT_SURCHARGE_BPS }, updatedAt: null };
  }
}

/** Persists new rates (admin path only) and refreshes the cache. */
export async function writeSurchargeSettings(
  rates: Partial<Record<CurrencyCode, number>>,
  userId: string,
): Promise<{ rates: Record<CurrencyCode, number>; updatedAt: string | null }> {
  const clean: Record<string, number> = {};
  for (const [code, value] of Object.entries(rates)) {
    const bps = normalizeSurchargeBps(value);
    if (bps !== null) clean[code] = bps;
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("pricing_settings")
    .upsert({ key: SETTINGS_KEY, surcharge_bps: clean }, { onConflict: "key" })
    .select("surcharge_bps, updated_at")
    .maybeSingle();

  if (error) {
    console.error("Surcharge settings write failed:", error.message);
    throw new Error("Could not save the surcharge settings. Try again shortly.");
  }

  const { error: auditError } = await supabaseAdmin
    .from("pricing_settings_audit")
    .upsert(
      { key: SETTINGS_KEY, updated_by: userId, updated_at: new Date().toISOString() },
      { onConflict: "key" },
    );
  if (auditError) console.error("Surcharge audit write failed:", auditError.message);

  applySurchargeBps((data?.surcharge_bps as Record<string, unknown>) ?? clean);
  const saved = currentSurchargeBps();
  cache = { rates: saved, updatedAt: (data?.updated_at as string | null) ?? null, at: Date.now() };
  return { rates: saved, updatedAt: cache.updatedAt };
}

/** Admin-only audit read: who last changed the surcharge. Never exposed publicly. */
export async function readSurchargeAudit(): Promise<{
  updatedAt: string | null;
  updatedById: string | null;
  updatedByEmail: string | null;
}> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("pricing_settings_audit")
    .select("updated_at, updated_by")
    .eq("key", SETTINGS_KEY)
    .maybeSingle();


  if (error) {
    console.error("Surcharge audit read failed:", error.message);
    throw new Error("Could not load the surcharge audit trail.");
  }

  const updatedById = (data?.updated_by as string | null) ?? null;
  let updatedByEmail: string | null = null;
  if (updatedById) {
    const { data: user } = await supabaseAdmin.auth.admin.getUserById(updatedById);
    updatedByEmail = user?.user?.email ?? null;
  }

  return {
    updatedAt: (data?.updated_at as string | null) ?? null,
    updatedById,
    updatedByEmail,
  };
}
