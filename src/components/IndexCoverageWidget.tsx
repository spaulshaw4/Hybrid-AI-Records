/**
 * Admin widget: sitemap-listed pages vs. Google index coverage.
 *
 * Reads stored snapshots on mount (cheap) and can run a live re-check that
 * inspects every sitemap URL, stores a new snapshot and flags sudden drops.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { getIndexCoverageAudit } from "@/lib/index-coverage.functions";
import type { CoveragePage, IndexCoverageAudit } from "@/lib/index-coverage";

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

function StateIcon({ page }: { page: CoveragePage }) {
  if (page.indexed === true) {
    return <CheckCircle2 size={14} className="text-[#3b6fe0]" aria-hidden="true" />;
  }
  if (page.indexed === false) {
    return <XCircle size={14} className="text-[#e11d2e]" aria-hidden="true" />;
  }
  return <MinusCircle size={14} className="text-muted-foreground" aria-hidden="true" />;
}

export function IndexCoverageWidget({ siteUrl }: { siteUrl: string }) {
  const audit = useServerFn(getIndexCoverageAudit);
  const [refreshing, setRefreshing] = useState(false);
  const [live, setLive] = useState<IndexCoverageAudit | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stored = useQuery({
    queryKey: ["index-coverage", siteUrl],
    queryFn: () => audit({ data: { refresh: false, siteUrl } }),
    staleTime: 60_000,
  });

  const data = live ?? stored.data ?? null;

  const runCheck = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await audit({ data: { refresh: true, siteUrl } });
      setLive(result);
      void stored.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The coverage check failed.");
    } finally {
      setRefreshing(false);
    }
  };

  const ok = data && data.status === "ok" ? data : null;
  const history = ok?.history ?? [];
  const current = ok?.current ?? null;
  const alerts = ok?.alerts ?? [];

  return (
    <section className="rounded-sm border border-border-strong bg-background/60 p-5 backdrop-blur-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-foreground">
            Sitemap vs. index coverage
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Compares the {current?.sitemapTotal ?? "—"} pages published in sitemap.xml against
            Google's index state, and alerts when indexed pages suddenly drop.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={runCheck} disabled={refreshing}>
          {refreshing ? (
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw size={14} aria-hidden="true" />
          )}
          {refreshing ? "Checking pages…" : "Run coverage check"}
        </Button>
      </div>

      {error ? <p className="mt-3 text-sm text-[#e11d2e]">{error}</p> : null}

      {stored.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading coverage history…</p>
      ) : null}

      {alerts.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {alerts.map((alert) => (
            <li
              key={alert.message}
              className={`flex items-start gap-2 rounded-sm border px-3 py-2 text-sm ${
                alert.severity === "critical"
                  ? "border-[#e11d2e]/60 bg-[#e11d2e]/10 text-foreground"
                  : "border-border-strong bg-background/40 text-muted-foreground"
              }`}
            >
              <AlertTriangle
                size={14}
                className={alert.severity === "critical" ? "mt-0.5 text-[#e11d2e]" : "mt-0.5"}
                aria-hidden="true"
              />
              <span>{alert.message}</span>
            </li>
          ))}
        </ul>
      ) : current ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 size={14} className="text-[#3b6fe0]" aria-hidden="true" />
          No coverage drops detected in the recorded history.
        </p>
      ) : null}

      {current ? (
        <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Sitemap pages", value: current.sitemapTotal },
            { label: "Indexed", value: current.indexedCount },
            { label: "Not indexed", value: current.notIndexedCount },
            { label: "Unknown", value: current.unknownCount },
          ].map((item) => (
            <div key={item.label} className="rounded-sm border border-border-strong px-3 py-2">
              <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {item.label}
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {history.length > 1 ? (
        <div className="mt-5 h-52 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={history} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid stroke="currentColor" strokeOpacity={0.1} vertical={false} />
              <XAxis
                dataKey="capturedAt"
                tickFormatter={shortDate}
                tick={{ fontSize: 11 }}
                stroke="currentColor"
                strokeOpacity={0.3}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="currentColor" strokeOpacity={0.3} />
              <Tooltip
                labelFormatter={(value) => new Date(String(value)).toLocaleString()}
                contentStyle={{ background: "hsl(var(--background))", border: "1px solid hsl(var(--border))" }}
              />
              <Area
                type="monotone"
                dataKey="indexedCount"
                name="Indexed pages"
                stroke="#3b6fe0"
                fill="#3b6fe0"
                fillOpacity={0.18}
              />
              <Area
                type="monotone"
                dataKey="sitemapTotal"
                name="Sitemap pages"
                stroke="#e11d2e"
                fill="#e11d2e"
                fillOpacity={0.06}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : current ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Run the check again later to build a trend line — drops are measured between snapshots.
        </p>
      ) : null}

      {ok?.pages && ok.pages.length > 0 ? (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">Sitemap page</th>
                <th className="px-3 py-2 font-medium">Coverage state</th>
                <th className="py-2 pl-3 text-right font-medium">Last crawled</th>
              </tr>
            </thead>
            <tbody>
              {ok.pages.map((page) => (
                <tr key={page.url} className="border-t border-border-strong/60">
                  <td className="py-2 pr-3">
                    <a
                      href={page.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 break-all text-foreground hover:text-primary"
                    >
                      <StateIcon page={page} />
                      {page.path} <ExternalLink size={11} aria-hidden="true" />
                    </a>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{page.coverageState ?? "—"}</td>
                  <td className="py-2 pl-3 text-right text-muted-foreground">
                    {page.lastCrawlTime ? new Date(page.lastCrawlTime).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!current && !stored.isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No snapshots recorded yet — run the coverage check to take the first one.
        </p>
      ) : null}
    </section>
  );
}
