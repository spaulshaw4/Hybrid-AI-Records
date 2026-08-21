import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { checkVisitorPricingAccess } from "@/lib/pricing-access-check.functions";

/**
 * Admin pre-deploy check: proves an anonymous visitor can still read the
 * pricing view. Run it after any pricing/permission change — a failure here is
 * what turns into a site-wide error page for logged-out traffic.
 */
export function PricingAccessCheckCard() {
  const run = useServerFn(checkVisitorPricingAccess);
  const check = useMutation({ mutationFn: () => run({}) });
  const report = check.data;

  return (
    <section className="mt-8 rounded-xl border border-border/60 bg-card/60 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold tracking-tight">Visitor read check</h2>
        </div>
        <Button size="sm" onClick={() => check.mutate()} disabled={check.isPending}>
          {check.isPending && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />}
          Run check
        </Button>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Reads the pricing view as a signed-out visitor. Run this before deploying any pricing or
        permission change — if it fails, logged-out visitors get an error page instead of the site.
      </p>

      {check.isError && (
        <p className="mt-3 text-xs text-destructive">
          Check could not run: {(check.error as Error).message}
        </p>
      )}

      {report && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <p className={`text-xs font-semibold ${report.ok ? "text-emerald-400" : "text-destructive"}`}>
            {report.ok ? "Safe to deploy — all checks passed." : "Do not deploy — visitor access is broken."}
          </p>
          <ul className="space-y-2">
            {report.checks.map((c) => (
              <li key={c.id} className="flex gap-2 rounded-lg border border-border/50 bg-background/50 p-3">
                {c.status === "pass" ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" aria-hidden="true" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                )}
                <div>
                  <p className="text-xs font-medium text-foreground">{c.label}</p>
                  <p className="text-xs text-muted-foreground">{c.detail}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            Checked {new Date(report.checkedAt).toLocaleString()}
          </p>
        </div>
      )}
    </section>
  );
}
