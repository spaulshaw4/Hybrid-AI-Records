import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { getPricingAccessAlerts } from "@/lib/pricing-access-monitor.functions";

const SOURCE_LABELS: Record<string, string> = {
  admin_settings_write: "Surcharge settings write",
  admin_audit_read: "Pricing audit trail read",
  anon_base_table_probe: "Anonymous base-table read",
};

/**
 * Admin view of the pricing access monitor: unexpected attempts to reach the
 * private pricing tables from non-admin roles, deduped with an occurrence count.
 */
export function PricingAccessAlertsCard() {
  const load = useServerFn(getPricingAccessAlerts);
  const alerts = useQuery({
    queryKey: ["pricing-access-alerts"],
    queryFn: () => load({}),
    refetchOnWindowFocus: false,
  });

  return (
    <section className="mt-8 rounded-xl border border-border/60 bg-card/60 p-5 backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-5 text-primary" aria-hidden="true" />
        <h2 className="text-sm font-semibold tracking-tight">Pricing access alerts</h2>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Logged whenever a non-admin role tries to read or change the private pricing settings, or an
        anonymous client unexpectedly reaches the base table. Repeats bump a counter.
      </p>

      {alerts.isPending && (
        <p className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading alerts…
        </p>
      )}

      {alerts.isError && (
        <p className="mt-4 text-xs text-destructive">
          Could not load alerts: {(alerts.error as Error).message}
        </p>
      )}

      {alerts.data && alerts.data.length === 0 && (
        <p className="mt-4 text-xs text-emerald-400">
          No unexpected pricing access attempts recorded.
        </p>
      )}

      {alerts.data && alerts.data.length > 0 && (
        <ul className="mt-4 space-y-2">
          {alerts.data.map((a) => (
            <li key={a.id} className="flex gap-2 rounded-lg border border-border/50 bg-background/50 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {SOURCE_LABELS[a.source] ?? a.source} — {a.outcome === "denied" ? "blocked" : "unexpectedly allowed"}
                </p>
                <p className="text-xs text-muted-foreground">{a.detail}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Role: {a.actorRole}
                  {a.actorUserId ? ` · User ${a.actorUserId.slice(0, 8)}…` : ""} · {a.occurrences}×
                  {" · "}
                  last {new Date(a.lastSeenAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
