/**
 * Staff-only Search Console reporting for the admin dashboard.
 *
 * Every function verifies an admin/staff role before touching the connector
 * gateway, since Search Console data isn't guarded by RLS.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export const TARGET_SITE = "https://hybrid-ai-records.com/";

export type PerformanceTotals = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type TrendPoint = PerformanceTotals & { date: string };
export type DimensionRow = PerformanceTotals & { key: string };

export type PerformanceReport =
  | { status: "selection_required"; candidates: string[] }
  | {
      status: "ok";
      siteUrl: string;
      range: { start: string; end: string; days: number };
      totals: PerformanceTotals;
      previousTotals: PerformanceTotals | null;
      trend: TrendPoint[];
      queries: DimensionRow[];
      pages: DimensionRow[];
      devices: DimensionRow[];
      countries: DimensionRow[];
      sitemaps: Array<{
        path: string;
        lastSubmitted: string | null;
        lastDownloaded: string | null;
        isPending: boolean;
        warnings: number;
        errors: number;
        submitted: number;
        indexed: number;
      }>;
      homepage: {
        coverageState: string | null;
        verdict: string | null;
        lastCrawlTime: string | null;
        robotsTxtState: string | null;
        indexingState: string | null;
        googleCanonical: string | null;
        userCanonical: string | null;
      } | null;
    };

const inputSchema = z
  .object({
    /** Whole days of history to report on (Search Console lags ~2 days). */
    days: z.union([z.literal(7), z.literal(28), z.literal(90), z.literal(180)]).default(28),
    /** Exact siteUrl returned by a previous `selection_required` response. */
    siteUrl: z.string().trim().max(300).optional(),
  })
  .default({ days: 28 });

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

/** Search Console finalises data with a ~2 day lag; skip the incomplete tail. */
function rangeFor(days: number, offsetDays = 0) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 2 - offsetDays * days);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: isoDay(start), end: isoDay(end) };
}

const EMPTY: PerformanceTotals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };

function aggregate(rows: Array<{ clicks: number; impressions: number; position: number }>) {
  if (rows.length === 0) return EMPTY;
  const clicks = rows.reduce((total, row) => total + row.clicks, 0);
  const impressions = rows.reduce((total, row) => total + row.impressions, 0);
  const weighted = rows.reduce((total, row) => total + row.position * row.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weighted / impressions : 0,
  };
}

export const getSearchConsoleReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => inputSchema.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<PerformanceReport> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden: staff access required.");

    const { resolveSiteUrl, searchAnalytics, listSitemaps, inspectUrl } = await import(
      "@/lib/search-console.server"
    );

    const resolution = await resolveSiteUrl(TARGET_SITE, data.siteUrl);
    if (resolution.status === "selection_required") {
      return { status: "selection_required", candidates: resolution.candidates };
    }
    const siteUrl = resolution.siteUrl;
    const current = rangeFor(data.days);
    const previous = rangeFor(data.days, 1);

    const base = { startDate: current.start, endDate: current.end };
    const [trendRows, queryRows, pageRows, deviceRows, countryRows, previousRows] =
      await Promise.all([
        searchAnalytics(siteUrl, { ...base, dimensions: ["date"], rowLimit: 500 }),
        searchAnalytics(siteUrl, { ...base, dimensions: ["query"], rowLimit: 25 }),
        searchAnalytics(siteUrl, { ...base, dimensions: ["page"], rowLimit: 25 }),
        searchAnalytics(siteUrl, { ...base, dimensions: ["device"], rowLimit: 10 }),
        searchAnalytics(siteUrl, { ...base, dimensions: ["country"], rowLimit: 10 }),
        searchAnalytics(siteUrl, {
          startDate: previous.start,
          endDate: previous.end,
          dimensions: ["date"],
          rowLimit: 500,
        }),
      ]);

    const [sitemaps, homepage] = await Promise.all([
      listSitemaps(siteUrl).catch(() => []),
      inspectUrl(siteUrl, TARGET_SITE).catch(() => null),
    ]);

    const toRows = (rows: typeof queryRows): DimensionRow[] =>
      rows.map((row) => ({
        key: row.keys?.[0] ?? "—",
        clicks: row.clicks,
        impressions: row.impressions,
        ctr: row.ctr,
        position: row.position,
      }));

    return {
      status: "ok",
      siteUrl,
      range: { start: current.start, end: current.end, days: data.days },
      totals: aggregate(trendRows),
      previousTotals: previousRows.length > 0 ? aggregate(previousRows) : null,
      trend: trendRows
        .map((row) => ({
          date: row.keys?.[0] ?? "",
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      queries: toRows(queryRows),
      pages: toRows(pageRows),
      devices: toRows(deviceRows),
      countries: toRows(countryRows),
      sitemaps,
      homepage,
    };
  });

export type SitemapSubmissionResult =
  | { status: "selection_required"; candidates: string[] }
  | {
      status: "ok";
      siteUrl: string;
      sitemapUrl: string;
      submittedAt: string;
      /** Google's processing status; null while the sitemap is still being registered. */
      sitemap: {
        path: string;
        lastSubmitted: string | null;
        lastDownloaded: string | null;
        isPending: boolean;
        warnings: number;
        errors: number;
        submitted: number;
        indexed: number;
      } | null;
    };

const submitSchema = z
  .object({
    /** Absolute sitemap URL; defaults to the live sitemap for this site. */
    sitemapUrl: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((value) => value.startsWith(TARGET_SITE), {
        message: "The sitemap URL must live on hybrid-ai-records.com.",
      })
      .default(`${TARGET_SITE}sitemap.xml`),
    siteUrl: z.string().trim().max(300).optional(),
  })
  .default({ sitemapUrl: `${TARGET_SITE}sitemap.xml` });

/** Staff-only: (re)submits the sitemap to Search Console and reads back its status. */
export const submitSitemapToSearchConsole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => submitSchema.parse(data ?? {}))
  .handler(async ({ data, context }): Promise<SitemapSubmissionResult> => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden: staff access required.");

    const { resolveSiteUrl, submitSitemap, getSitemapStatus } = await import(
      "@/lib/search-console.server"
    );

    const resolution = await resolveSiteUrl(TARGET_SITE, data.siteUrl);
    if (resolution.status === "selection_required") {
      return { status: "selection_required", candidates: resolution.candidates };
    }

    await submitSitemap(resolution.siteUrl, data.sitemapUrl);
    const sitemap = await getSitemapStatus(resolution.siteUrl, data.sitemapUrl).catch(() => null);

    return {
      status: "ok",
      siteUrl: resolution.siteUrl,
      sitemapUrl: data.sitemapUrl,
      submittedAt: new Date().toISOString(),
      sitemap,
    };
  });
