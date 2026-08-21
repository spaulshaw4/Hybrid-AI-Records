import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PricingAccessCheck = {
  /** Machine id so the UI can key rows without matching on prose. */
  id: "public_view_read" | "base_table_protected" | "surcharge_shape";
  label: string;
  status: "pass" | "fail";
  detail: string;
};

export type PricingAccessReport = {
  checkedAt: string;
  ok: boolean;
  checks: PricingAccessCheck[];
};

/**
 * Pre-deploy smoke test for anonymous pricing reads.
 *
 * Runs as a real visitor (publishable key, no session) so it catches the exact
 * failure mode that took the site down before: a revoked GRANT or a
 * security_invoker view that silently blocks `anon` and makes every SSR render
 * throw. Admin-gated because the result names our table/view internals.
 */
export const checkVisitorPricingAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.undefined().or(z.null()).parse(data ?? undefined))
  .handler(async ({ context }): Promise<PricingAccessReport> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden");

    const { createClient } = await import("@supabase/supabase-js");
    const anon = createClient(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_PUBLISHABLE_KEY"]!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );

    const checks: PricingAccessCheck[] = [];

    // 1. The read the storefront actually performs on every render.
    const view = await anon
      .from("pricing_settings_public")
      .select("key, surcharge_bps, updated_at")
      .eq("key", "surcharge")
      .maybeSingle();

    checks.push({
      id: "public_view_read",
      label: "Visitors can read pricing_settings_public",
      status: view.error ? "fail" : "pass",
      detail: view.error
        ? `Blocked: ${view.error.message}. Visitors would see the error page — grant SELECT on the view to anon before deploying.`
        : view.data
          ? "Anonymous read returned the live surcharge row."
          : "Read allowed, but the 'surcharge' row is missing — prices fall back to defaults.",
    });

    // 2. The row must be usable, not just readable.
    const bps = (view.data?.surcharge_bps ?? null) as Record<string, unknown> | null;
    const shapeOk = !!bps && typeof bps === "object" && Object.keys(bps).length > 0;
    checks.push({
      id: "surcharge_shape",
      label: "Surcharge rates parse into currency values",
      status: view.error ? "fail" : shapeOk ? "pass" : "fail",
      detail: shapeOk
        ? `Rates present for: ${Object.keys(bps!).join(", ")}.`
        : "No usable rate map — checkout would quote built-in defaults.",
    });

    // 3. The private column must stay private. Failure here is a leak, not an outage.
    const base = await anon.from("pricing_settings").select("updated_by").limit(1);
    const leaked = !base.error && (base.data?.length ?? 0) > 0;
    checks.push({
      id: "base_table_protected",
      label: "Private pricing columns stay hidden from visitors",
      status: leaked ? "fail" : "pass",
      detail: leaked
        ? "Anonymous clients can read pricing_settings.updated_by — tighten the base-table policy before deploying."
        : "Anonymous access to the base table's private columns is refused, as expected.",
    });

    // Monitoring hook: an anon read that succeeds here is a real exposure, so
    // it is recorded for review rather than only shown in this one-off report.
    if (leaked) {
      const { recordPricingAccessAlert } = await import("@/lib/pricing-access-monitor.server");
      await recordPricingAccessAlert({
        actorRole: "anon",
        actorUserId: null,
        source: "anon_base_table_probe",
        outcome: "unexpected_success",
        detail: "Anonymous client read pricing_settings.updated_by from the base table.",
      });
    }


    return {
      checkedAt: new Date().toISOString(),
      ok: checks.every((c) => c.status === "pass"),
      checks,
    };
  });
