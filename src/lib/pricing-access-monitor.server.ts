/**
 * Lightweight security monitoring for the private pricing tables.
 *
 * Pricing settings hold the surcharge configuration and (in the audit table)
 * admin identities, so they are readable only by admins. Anything else that
 * tries — a non-admin calling an admin-only pricing server fn, or an anonymous
 * client managing to read the base table during the visitor probe — is
 * recorded here for review instead of failing silently.
 *
 * Writes go through the service role: the alert log is staff-readable only and
 * must never be writable from the app.
 */

export type PricingAccessSource =
  | "admin_settings_write"
  | "admin_audit_read"
  | "anon_base_table_probe";

export type PricingAccessOutcome = "denied" | "unexpected_success";

export type PricingAccessAlertInput = {
  /** Effective role of the caller as far as the app could tell. */
  actorRole: string;
  actorUserId?: string | null;
  source: PricingAccessSource;
  outcome: PricingAccessOutcome;
  detail?: string | null;
};

export type PricingAccessAlert = {
  id: string;
  actorRole: string;
  actorUserId: string | null;
  source: string;
  outcome: string;
  detail: string | null;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Records one unexpected pricing access attempt, deduped by
 * (role, source, outcome, user) so a repeated probe bumps a counter instead of
 * flooding the log. Never throws — monitoring must not break the caller.
 */
export async function recordPricingAccessAlert(input: PricingAccessAlertInput): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const userId = input.actorUserId ?? null;
    const now = new Date().toISOString();

    const { data: existing } = await supabaseAdmin
      .from("pricing_access_alerts")
      .select("id, occurrences")
      .eq("actor_role", input.actorRole)
      .eq("source", input.source)
      .eq("outcome", input.outcome)
      .eq("actor_user_id", userId ?? NIL_UUID)
      .maybeSingle();

    if (existing) {
      await supabaseAdmin
        .from("pricing_access_alerts")
        .update({
          occurrences: (existing.occurrences ?? 1) + 1,
          last_seen_at: now,
          detail: input.detail ?? null,
        })
        .eq("id", existing.id);
      return;
    }

    await supabaseAdmin.from("pricing_access_alerts").insert({
      actor_role: input.actorRole,
      actor_user_id: userId,
      source: input.source,
      outcome: input.outcome,
      detail: input.detail ?? null,
      first_seen_at: now,
      last_seen_at: now,
    });
  } catch (err) {
    console.error("Pricing access alert write failed:", (err as Error).message);
  }
}

/** Admin-only read of the most recent alerts. */
export async function readPricingAccessAlerts(limit = 25): Promise<PricingAccessAlert[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("pricing_access_alerts")
    .select("id, actor_role, actor_user_id, source, outcome, detail, occurrences, first_seen_at, last_seen_at")
    .order("last_seen_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return (data ?? []).map((row) => ({
    id: row.id as string,
    actorRole: row.actor_role as string,
    actorUserId: (row.actor_user_id as string | null) ?? null,
    source: row.source as string,
    outcome: row.outcome as string,
    detail: (row.detail as string | null) ?? null,
    occurrences: (row.occurrences as number) ?? 1,
    firstSeenAt: row.first_seen_at as string,
    lastSeenAt: row.last_seen_at as string,
  }));
}
