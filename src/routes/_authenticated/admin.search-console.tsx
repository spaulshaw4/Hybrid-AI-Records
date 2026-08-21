import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AreaChart,
  Area,
  Line,
  ComposedChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Loader2,
  RefreshCw,
  Search,
  TrendingUp,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { pageHead } from "@/lib/social-meta";
import { SitemapSubmitAction } from "@/components/SitemapSubmitAction";
import { IndexCoverageWidget } from "@/components/IndexCoverageWidget";
import {
  getSearchConsoleReport,
  type DimensionRow,
  type PerformanceReport,
  type PerformanceTotals,
} from "@/lib/search-console.functions";

export const Route = createFileRoute("/_authenticated/admin/search-console")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/search-console",
      title: "Search Console Dashboard — Hybrid AI Records",
      description:
        "Private staff dashboard for Google Search clicks, impressions, CTR, average position and indexing trends.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminSearchConsole,
});

const RANGES = [7, 28, 90, 180] as const;

const nf = new Intl.NumberFormat("en-US");
const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
const pos = (value: number) => (value > 0 ? value.toFixed(1) : "—");

function delta(current: number, previous: number | undefined, invert = false) {
  if (previous == null || previous === 0) return null;
  const change = (current - previous) / previous;
  return { change, good: invert ? change < 0 : change > 0 };
}

function MetricCard({
  label,
  value,
  previous,
  current,
  invert,
}: {
  label: string;
  value: string;
  previous?: number;
  current: number;
  invert?: boolean;
}) {
  const diff = delta(current, previous, invert);
  return (
    <div className="border border-border-strong bg-background/40 p-5 backdrop-blur-sm">
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-2 font-display text-3xl font-bold tracking-tight">{value}</p>
      {diff ? (
        <p
          className={`mt-1 flex items-center gap-1 font-mono text-[11px] ${
            diff.good ? "text-[#3b82f6]" : "text-[#e11d2e]"
          }`}
        >
          {diff.good ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
          {(Math.abs(diff.change) * 100).toFixed(1)}% vs previous period
        </p>
      ) : (
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">no prior data</p>
      )}
    </div>
  );
}

function DimensionTable({ title, rows }: { title: string; rows: DimensionRow[] }) {
  return (
    <section className="border border-border-strong bg-background/40 backdrop-blur-sm">
      <h2 className="border-b border-border-strong px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No reported data yet.</p>
      ) : (
        <div className="max-h-[420px] overflow-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-background/90 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-4 py-2 font-medium">Key</th>
                <th className="px-3 py-2 text-right font-medium">Clicks</th>
                <th className="px-3 py-2 text-right font-medium">Impr.</th>
                <th className="px-3 py-2 text-right font-medium">CTR</th>
                <th className="px-4 py-2 text-right font-medium">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border-strong/60">
                  <td className="max-w-[280px] truncate px-4 py-2" title={row.key}>
                    {row.key}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{nf.format(row.clicks)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {nf.format(row.impressions)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(row.ctr)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{pos(row.position)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AdminSearchConsole() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(28);
  const [siteUrl, setSiteUrl] = useState<string | undefined>(undefined);

  const fetchReport = useServerFn(getSearchConsoleReport);
  const query = useQuery({
    queryKey: ["search-console", days, siteUrl],
    queryFn: () => fetchReport({ data: { days, siteUrl } }),
    staleTime: 5 * 60 * 1000,
  });

  const report = query.data;
  const forbidden = query.error ? /forbidden/i.test(String(query.error)) : false;

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Search performance</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Search Console Dashboard
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Google Search clicks, impressions, CTR, average position and indexing state for
          hybrid-ai-records.com. Google finalises data with roughly a two-day lag, so the most
          recent days are excluded.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            to="/admin/applications"
            className="inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Search size={13} aria-hidden="true" /> Applications inbox
          </Link>
        </div>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            onClick={() => setDays(range)}
            className={`border px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] transition-colors ${
              days === range
                ? "border-primary text-primary"
                : "border-border-strong text-muted-foreground hover:text-foreground"
            }`}
          >
            Last {range} days
          </button>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
          className="ml-auto"
        >
          {query.isFetching ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Refresh
        </Button>
      </div>

      {forbidden ? (
        <div role="alert" className="border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-semibold text-foreground">This dashboard is staff-only.</p>
          <p className="mt-1 text-muted-foreground">
            Your account doesn't have the admin or staff role yet.
          </p>
        </div>
      ) : query.error ? (
        <div role="alert" className="border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-semibold text-foreground">Couldn't load Search Console data.</p>
          <p className="mt-1 text-muted-foreground">{String(query.error)}</p>
        </div>
      ) : query.isLoading || !report ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" /> Loading Search Console data…
        </p>
      ) : report.status === "selection_required" ? (
        <div className="border border-border-strong bg-background/40 p-6">
          <p className="text-sm text-foreground">
            Several verified properties cover this site. Pick the one to report on:
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {report.candidates.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => setSiteUrl(candidate)}
                className="border border-border-strong px-4 py-2 font-mono text-[11px] text-foreground transition-colors hover:border-primary hover:text-primary"
              >
                {candidate}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <Report report={report} onSitemapSubmitted={() => query.refetch()} />
      )}
    </main>
  );
}

function Report({
  report,
  onSitemapSubmitted,
}: {
  report: Extract<PerformanceReport, { status: "ok" }>;
  onSitemapSubmitted?: () => void;
}) {

  const prev: PerformanceTotals | null = report.previousTotals;
  return (
    <div className="space-y-8">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {report.siteUrl} · {report.range.start} → {report.range.end}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Clicks"
          value={nf.format(report.totals.clicks)}
          current={report.totals.clicks}
          previous={prev?.clicks}
        />
        <MetricCard
          label="Impressions"
          value={nf.format(report.totals.impressions)}
          current={report.totals.impressions}
          previous={prev?.impressions}
        />
        <MetricCard
          label="CTR"
          value={pct(report.totals.ctr)}
          current={report.totals.ctr}
          previous={prev?.ctr}
        />
        <MetricCard
          label="Avg. position"
          value={pos(report.totals.position)}
          current={report.totals.position}
          previous={prev?.position}
          invert
        />
      </div>

      <section className="border border-border-strong bg-background/40 p-5 backdrop-blur-sm">
        <h2 className="flex items-center gap-2 font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
          <TrendingUp size={13} aria-hidden="true" /> Clicks &amp; impressions over time
        </h2>
        <div className="mt-4 h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={report.trend}>
              <defs>
                <linearGradient id="clicksFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#e11d2e" stopOpacity={0.55} />
                  <stop offset="100%" stopColor="#e11d2e" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="imprFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="rgba(255,255,255,0.4)" />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} stroke="#e11d2e" />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 11 }}
                stroke="#3b82f6"
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(10,10,12,0.92)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  fontSize: 12,
                }}
              />
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="impressions"
                stroke="#3b82f6"
                fill="url(#imprFill)"
                strokeWidth={2}
              />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="clicks"
                stroke="#e11d2e"
                fill="url(#clicksFill)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="border border-border-strong bg-background/40 p-5 backdrop-blur-sm">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
          CTR &amp; average position
        </h2>
        <div className="mt-4 h-[240px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={report.trend}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="rgba(255,255,255,0.4)" />
              <YAxis yAxisId="ctr" tick={{ fontSize: 11 }} stroke="#ffffff" />
              <YAxis
                yAxisId="pos"
                orientation="right"
                reversed
                tick={{ fontSize: 11 }}
                stroke="#e11d2e"
              />
              <Tooltip
                contentStyle={{
                  background: "rgba(10,10,12,0.92)",
                  border: "1px solid rgba(255,255,255,0.15)",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) =>
                  name === "ctr" ? pct(value) : value.toFixed(1)
                }
              />
              <Line
                yAxisId="ctr"
                type="monotone"
                dataKey="ctr"
                stroke="#ffffff"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="pos"
                type="monotone"
                dataKey="position"
                stroke="#e11d2e"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          White = CTR · Crimson = average position (inverted, lower is better)
        </p>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <DimensionTable title="Top queries" rows={report.queries} />
        <DimensionTable title="Top pages" rows={report.pages} />
        <DimensionTable title="Devices" rows={report.devices} />
        <DimensionTable title="Countries" rows={report.countries} />
      </div>

      <section className="border border-border-strong bg-background/40 p-5 backdrop-blur-sm">
        <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em]">
          Indexing &amp; sitemaps
        </h2>
        {report.homepage ? (
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Homepage coverage
              </dt>
              <dd className="text-foreground">{report.homepage.coverageState ?? "unknown"}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Verdict
              </dt>
              <dd className="text-foreground">{report.homepage.verdict ?? "unknown"}</dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Last crawl
              </dt>
              <dd className="text-foreground">
                {report.homepage.lastCrawlTime
                  ? new Date(report.homepage.lastCrawlTime).toLocaleString()
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Google-selected canonical
              </dt>
              <dd className="break-all text-foreground">
                {report.homepage.googleCanonical ?? "—"}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            Index state for the homepage is unavailable right now.
          </p>
        )}

        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Sitemap</th>
                <th className="px-3 py-2 text-right font-medium">Submitted URLs</th>
                <th className="px-3 py-2 text-right font-medium">Indexed</th>
                <th className="px-3 py-2 text-right font-medium">Errors</th>
                <th className="px-3 py-2 text-right font-medium">Warnings</th>
                <th className="py-2 pl-3 text-right font-medium">Last downloaded</th>
              </tr>
            </thead>
            <tbody>
              {report.sitemaps.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-4 text-muted-foreground">
                    No sitemaps reported for this property.
                  </td>
                </tr>
              ) : (
                report.sitemaps.map((sitemap) => (
                  <tr key={sitemap.path} className="border-t border-border-strong/60">
                    <td className="py-2 pr-3">
                      <a
                        href={sitemap.path}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 break-all text-foreground hover:text-primary"
                      >
                        {sitemap.path} <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {nf.format(sitemap.submitted)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {nf.format(sitemap.indexed)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        sitemap.errors > 0 ? "text-[#e11d2e]" : ""
                      }`}
                    >
                      {sitemap.errors}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{sitemap.warnings}</td>
                    <td className="py-2 pl-3 text-right">
                      {sitemap.lastDownloaded
                        ? new Date(sitemap.lastDownloaded).toLocaleDateString()
                        : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Error and warning counts come straight from Google; they report that something failed
          but not the cause.
        </p>

        <SitemapSubmitAction siteUrl={report.siteUrl} onSubmitted={onSitemapSubmitted} />
      </section>

      <IndexCoverageWidget siteUrl={report.siteUrl} />
    </div>
  );
}
