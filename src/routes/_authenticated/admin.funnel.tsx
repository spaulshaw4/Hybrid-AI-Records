import { createFileRoute } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, RefreshCw, TrendingDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getFunnelSummary, getHowItWorksCtaClicks } from "@/lib/admin-funnel.functions";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/_authenticated/admin/funnel")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/funnel",
      title: "Application Funnel — Hybrid AI Records",
      description: "Staff view of step views, completions and payment starts across the 4-step application flow.",
      socialTitle: "Application Funnel — Hybrid AI Records",
      socialDescription: "Drop-off across the 4-step application flow.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminFunnel,
});

const WINDOWS = [7, 30, 90];

function AdminFunnel() {
  const [days, setDays] = useState(30);
  const [packageSlug, setPackageSlug] = useState<string | null>(null);
  const fetchSummary = useServerFn(getFunnelSummary);

  const query = useQuery({
    queryKey: ["admin-funnel", days, packageSlug],
    queryFn: () => fetchSummary({ data: { days, packageSlug } }),
  });

  const fetchCtaClicks = useServerFn(getHowItWorksCtaClicks);
  const ctaQuery = useQuery({
    queryKey: ["admin-cta-how-it-works", days],
    queryFn: () => fetchCtaClicks({ data: { days } }),
  });

  const summary = query.data;
  const cta = ctaQuery.data;
  const forbidden = query.isError && /forbidden/i.test((query.error as Error)?.message ?? "");

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Application funnel</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold text-white">Step drop-off</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Unique visitors who saw and completed each of the four application steps, plus how many
          started a Stripe payment.
        </p>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setDays(w)}
            className={`border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest transition-colors ${
              days === w
                ? "border-[#e11d2e] bg-[#e11d2e] text-white"
                : "border-border-strong text-muted-foreground hover:text-white"
            }`}
          >
            Last {w} days
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-border" />
        <button
          type="button"
          onClick={() => setPackageSlug(null)}
          className={`border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${
            packageSlug === null
              ? "border-[#4b8bff] text-[#4b8bff]"
              : "border-border-strong text-muted-foreground hover:text-white"
          }`}
        >
          All packages
        </button>
        {(summary?.packages ?? []).map((slug) => (
          <button
            key={slug}
            type="button"
            onClick={() => setPackageSlug(slug)}
            className={`border px-3 py-1.5 text-xs font-semibold uppercase tracking-widest ${
              packageSlug === slug
                ? "border-[#4b8bff] text-[#4b8bff]"
                : "border-border-strong text-muted-foreground hover:text-white"
            }`}
          >
            {slug}
          </button>
        ))}
        <Button variant="ghost" size="sm" onClick={() => { void query.refetch(); void ctaQuery.refetch(); }} className="ml-auto">
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {query.isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading funnel…
        </p>
      )}

      {forbidden && (
        <p className="border border-[#e11d2e]/50 bg-[#e11d2e]/10 px-4 py-3 text-sm text-white">
          You need an admin or staff role to view funnel data.
        </p>
      )}

      {summary && !query.isLoading && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <Stat label="Visitors" value={summary.visitors} />
            <Stat label="Reached final step" value={summary.steps[3]?.views ?? 0} />
            <Stat label="Payments started" value={summary.paymentsInitiated} />
          </div>

          <div className="border border-border-strong">
            <table className="w-full text-sm">
              <thead className="bg-background/40 text-xs uppercase tracking-widest text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left">Step</th>
                  <th className="px-4 py-3 text-right">Views</th>
                  <th className="px-4 py-3 text-right">Completed</th>
                  <th className="px-4 py-3 text-right">Drop-off</th>
                </tr>
              </thead>
              <tbody>
                {summary.steps.map((step) => (
                  <tr key={step.slug} className="border-t border-border/60">
                    <td className="px-4 py-3 text-white">{step.label}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{step.views}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{step.completions}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-[#e11d2e]">
                      <span className="inline-flex items-center gap-1">
                        <TrendingDown className="h-3.5 w-3.5" />
                        {step.dropOffPct}%
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <section className="mt-12">
        <h2 className="font-display text-2xl font-bold text-white">
          &ldquo;See how it works — 3 steps&rdquo; clicks
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Which service card sends the most people down to the 3-step process section
          (last {days} days).
        </p>

        {ctaQuery.isLoading && (
          <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading CTA clicks…
          </p>
        )}

        {cta && !ctaQuery.isLoading && (
          cta.totalClicks === 0 ? (
            <p className="mt-4 border border-border-strong bg-background/30 px-4 py-3 text-sm text-muted-foreground">
              No clicks recorded yet in this window.
            </p>
          ) : (
            <div className="mt-4 border border-border-strong">
              <table className="w-full text-sm">
                <thead className="bg-background/40 text-xs uppercase tracking-widest text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 text-left">Service</th>
                    <th className="px-4 py-3 text-right">Clicks</th>
                    <th className="px-4 py-3 text-right">Unique visitors</th>
                    <th className="px-4 py-3 text-right">Share</th>
                  </tr>
                </thead>
                <tbody>
                  {cta.rows.map((row) => (
                    <tr key={row.packageSlug} className="border-t border-border/60">
                      <td className="px-4 py-3 text-white">{row.serviceTitle}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.clicks}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{row.uniqueVisitors}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-[#4b8bff]">
                        {row.sharePct}%
                      </td>
                    </tr>
                  ))}
                  <tr className="border-t border-border-strong bg-background/40">
                    <td className="px-4 py-3 text-xs uppercase tracking-widest text-muted-foreground">
                      Total
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums text-white">
                      {cta.totalClicks}
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                  </tr>
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border-strong bg-background/30 p-5">
      <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-display text-3xl font-bold text-white tabular-nums">{value}</div>
    </div>
  );
}
