import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/pricing";
import { isPlausibleRate } from "@/lib/fx";

/**
 * Daily FX refresh. Called by a scheduled job (pg_cron) once a day; pulls
 * USD-based rates from the provider and stores the ones that pass our
 * plausibility check. Rates the provider omits or fumbles are left untouched,
 * so the last good quote keeps standing rather than breaking prices.
 */

const PROVIDER = "https://open.er-api.com/v6/latest/USD";

const providerSchema = z.object({
  result: z.string().optional(),
  time_last_update_utc: z.string().optional(),
  rates: z.record(z.string(), z.number()),
});

export const Route = createFileRoute("/api/public/hooks/refresh-fx")({
  server: {
    handlers: {
      POST: async ({ request }) => (await authorize(request)) ?? refresh(),
      // Unauthenticated browsing/probing gets nothing useful.
      GET: async () => methodNotAllowed(),
      PUT: async () => methodNotAllowed(),
      DELETE: async () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ ok: false, error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}

function unauthorized(reason: string): Response {
  console.warn(`FX refresh rejected: ${reason}`);
  return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
}

/**
 * Two callers may trigger a refresh:
 *  1. The scheduled job, presenting the server-only FX_REFRESH_SECRET in the
 *     `x-fx-refresh-secret` header (timing-safe compared over SHA-256 digests).
 *  2. A signed-in admin, presenting their Supabase access token as a bearer
 *     token; the role is verified server-side via has_role().
 * The publishable/anon key is NOT accepted — it ships to browsers and is public.
 */
async function authorize(request: Request): Promise<Response | null> {
  const secrets = [
    process.env["FX_REFRESH_CRON_KEY"] ?? "",
    process.env["FX_REFRESH_SECRET"] ?? "",
  ].filter(Boolean);
  const presented = (request.headers.get("x-fx-refresh-secret") ?? "").trim();
  if (secrets.length > 0 && presented) {
    const matches = await Promise.all(secrets.map((s) => timingSafeEqualStrings(presented, s)));
    return matches.some(Boolean) ? null : unauthorized("invalid refresh secret");
  }


  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return unauthorized("missing credentials");

  const url = process.env["SUPABASE_URL"];
  const anonKey = process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["SUPABASE_ANON_KEY"];
  if (!url || !anonKey) return unauthorized("auth not configured");

  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) return unauthorized("invalid session token");

  const { data: isAdmin, error: roleError } = await client.rpc("has_role", {
    _user_id: userData.user.id,
    _role: "admin",
  });
  if (roleError || !isAdmin) return unauthorized("caller is not an admin");
  return null;
}

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const l = new Uint8Array(left);
  const r = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < l.length; i += 1) diff |= (l[i] ?? 0) ^ (r[i] ?? 0);
  return diff === 0;
}




async function refresh(): Promise<Response> {
  try {
    const response = await fetch(PROVIDER, { headers: { accept: "application/json" } });
    if (!response.ok) {
      const body = await response.text();
      console.error(`FX provider failed [${response.status}]: ${body}`);
      return Response.json(
        { ok: false, error: `Provider request failed [${response.status}]` },
        { status: 502 },
      );
    }

    const parsed = providerSchema.parse(await response.json());
    const fetchedAt = new Date().toISOString();

    const rows = CURRENCY_CODES.filter((code: CurrencyCode) => code !== "usd")
      .map((code) => ({ code, rate: parsed.rates[code.toUpperCase()] }))
      .filter((row) => isPlausibleRate(row.code, row.rate))

      .map((row) => ({
        currency: row.code,
        rate: row.rate,
        source: "open.er-api.com",
        fetched_at: fetchedAt,
      }));

    if (rows.length === 0) {
      return Response.json({ ok: false, error: "No plausible rates returned" }, { status: 502 });
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("fx_rates")
      .upsert(rows, { onConflict: "currency" });
    if (error) {
      console.error("FX upsert failed:", error.message);
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    const { invalidateFxCache } = await import("@/lib/fx-rates.server");
    invalidateFxCache();

    return Response.json({
      ok: true,
      fetchedAt,
      providerUpdatedAt: parsed.time_last_update_utc ?? null,
      rates: Object.fromEntries(rows.map((r) => [r.currency, r.rate])),
    });
  } catch (err) {
    console.error("FX refresh failed:", (err as Error).message);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
