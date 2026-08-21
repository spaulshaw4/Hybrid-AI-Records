/**
 * Staff-only index-coverage audit server function.
 *
 * Compares the pages advertised in sitemap.xml against Google's index state,
 * stores a snapshot on each refresh, and flags sudden drops.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { IndexCoverageAudit } from "@/lib/index-coverage";
import { z } from "zod";

const schema = z
  .object({
    /** Re-inspect every sitemap URL through Search Console and store a snapshot. */
    refresh: z.boolean().default(false),
    siteUrl: z.string().trim().max(300).optional(),
  })
  .default({ refresh: false });

export const getIndexCoverageAudit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => schema.parse(data ?? {}))
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden: staff access required.");

    const { resolveSiteUrl, inspectUrl, listSitemaps } = await import(
      "@/lib/search-console.server"
    );
    const { buildCoverageAlerts, isIndexed, toSnapshot } = await import("@/lib/index-coverage");
    const { sitemapUrls, SITEMAP_BASE_URL } = await import("@/lib/sitemap-pages");


    const target = `${SITEMAP_BASE_URL}/`;
    const resolution = await resolveSiteUrl(target, data.siteUrl);
    if (resolution.status === "selection_required") {
      return {
        status: "selection_required" as const,
        candidates: resolution.candidates,
      } satisfies IndexCoverageAudit;
    }
    const siteUrl = resolution.siteUrl;

    const readHistory = async () => {
      const { data: rows } = await context.supabase
        .from("index_coverage_snapshots")
        .select(
          "captured_at, sitemap_total, indexed_count, not_indexed_count, unknown_count, sitemap_submitted, sitemap_indexed",
        )
        .eq("site_url", siteUrl)
        .order("captured_at", { ascending: false })
        .limit(30);
      return (rows ?? []).map(toSnapshot);
    };

    if (!data.refresh) {
      const history = await readHistory();
      const current = history[0] ?? null;
      const previous = history[1] ?? null;
      return {
        status: "ok" as const,
        siteUrl,
        pages: null,
        current,
        previous,
        history: [...history].reverse(),
        alerts: buildCoverageAlerts(current, previous, null),
      } satisfies IndexCoverageAudit;
    }

    const inspected = await Promise.all(
      sitemapUrls().map(async (url) => {
        const state = await inspectUrl(siteUrl, url).catch(() => null);
        return {
          url,
          path: new URL(url).pathname,
          coverageState: state?.coverageState ?? null,
          verdict: state?.verdict ?? null,
          lastCrawlTime: state?.lastCrawlTime ?? null,
          robotsTxtState: state?.robotsTxtState ?? null,
          indexed: state ? isIndexed(state.coverageState, state.verdict) : null,
        };
      }),
    );

    const sitemaps = await listSitemaps(siteUrl).catch(() => []);
    const sitemapEntry =
      sitemaps.find((entry) => entry.path.endsWith("/sitemap.xml")) ?? sitemaps[0] ?? null;

    const snapshot = {
      capturedAt: new Date().toISOString(),
      sitemapTotal: inspected.length,
      indexedCount: inspected.filter((page) => page.indexed === true).length,
      notIndexedCount: inspected.filter((page) => page.indexed === false).length,
      unknownCount: inspected.filter((page) => page.indexed === null).length,
      sitemapSubmitted: sitemapEntry?.submitted ?? 0,
      sitemapIndexed: sitemapEntry?.indexed ?? 0,
    };

    const priorHistory = await readHistory();
    const previous = priorHistory[0] ?? null;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("index_coverage_snapshots").insert({
      site_url: siteUrl,
      sitemap_total: snapshot.sitemapTotal,
      indexed_count: snapshot.indexedCount,
      not_indexed_count: snapshot.notIndexedCount,
      unknown_count: snapshot.unknownCount,
      sitemap_submitted: snapshot.sitemapSubmitted,
      sitemap_indexed: snapshot.sitemapIndexed,
      captured_at: snapshot.capturedAt,
      pages: inspected,
    });

    return {
      status: "ok" as const,
      siteUrl,
      pages: inspected,
      current: snapshot,
      previous,
      history: [...priorHistory].reverse().concat(snapshot).slice(-30),
      alerts: buildCoverageAlerts(snapshot, previous, inspected),
    } satisfies IndexCoverageAudit;
  });
