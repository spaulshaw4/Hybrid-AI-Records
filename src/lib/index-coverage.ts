/**
 * Pure helpers and types for the sitemap ↔ Search Console index-coverage audit.
 * Kept out of the server-function module so the function-splitting build step
 * can't strip them.
 */

export type CoveragePage = {
  url: string;
  path: string;
  indexed: boolean | null;
  coverageState: string | null;
  verdict: string | null;
  lastCrawlTime: string | null;
  robotsTxtState: string | null;
};

export type CoverageSnapshot = {
  capturedAt: string;
  sitemapTotal: number;
  indexedCount: number;
  notIndexedCount: number;
  unknownCount: number;
  sitemapSubmitted: number;
  sitemapIndexed: number;
};

export type CoverageAlert = {
  severity: "warning" | "critical";
  message: string;
};

export type IndexCoverageAudit =
  | { status: "selection_required"; candidates: string[] }
  | {
      status: "ok";
      siteUrl: string;
      /** Null when we only read stored history and never inspected live. */
      pages: CoveragePage[] | null;
      current: CoverageSnapshot | null;
      previous: CoverageSnapshot | null;
      history: CoverageSnapshot[];
      alerts: CoverageAlert[];
    };

export type SnapshotRow = {
  captured_at: string;
  sitemap_total: number;
  indexed_count: number;
  not_indexed_count: number;
  unknown_count: number;
  sitemap_submitted: number;
  sitemap_indexed: number;
};

export const toSnapshot = (row: SnapshotRow): CoverageSnapshot => ({
  capturedAt: row.captured_at,
  sitemapTotal: row.sitemap_total,
  indexedCount: row.indexed_count,
  notIndexedCount: row.not_indexed_count,
  unknownCount: row.unknown_count,
  sitemapSubmitted: row.sitemap_submitted,
  sitemapIndexed: row.sitemap_indexed,
});

/** A URL counts as indexed when Google reports it as being on Google. */
export function isIndexed(coverageState: string | null, verdict: string | null) {
  if (!coverageState && !verdict) return null;
  const state = (coverageState ?? "").toLowerCase();
  if (state.includes("submitted and indexed") || state.includes("indexed, not submitted")) {
    return true;
  }
  if (state === "" && verdict) return verdict.toUpperCase() === "PASS";
  return verdict?.toUpperCase() === "PASS" && !state.includes("not indexed");
}

/** Drop rules: any loss is surfaced; >20% of pages or >2 pages is critical. */
export function buildCoverageAlerts(
  current: CoverageSnapshot | null,
  previous: CoverageSnapshot | null,
  pages: CoveragePage[] | null,
): CoverageAlert[] {
  const alerts: CoverageAlert[] = [];
  if (!current) return alerts;

  if (previous) {
    const delta = current.indexedCount - previous.indexedCount;
    if (delta < 0) {
      const lost = Math.abs(delta);
      const share = previous.indexedCount > 0 ? lost / previous.indexedCount : 1;
      alerts.push({
        severity: share >= 0.2 || lost > 2 ? "critical" : "warning",
        message: `Indexed pages dropped from ${previous.indexedCount} to ${current.indexedCount} (−${lost}, ${Math.round(share * 100)}%) since the ${new Date(previous.capturedAt).toLocaleString()} check.`,
      });
    }
    if (current.sitemapIndexed < previous.sitemapIndexed) {
      alerts.push({
        severity: "warning",
        message: `Search Console's sitemap indexed count fell from ${previous.sitemapIndexed} to ${current.sitemapIndexed}.`,
      });
    }
  }

  const missing = (pages ?? []).filter((page) => page.indexed === false);
  if (missing.length > 0) {
    alerts.push({
      severity: missing.length >= Math.ceil(current.sitemapTotal / 2) ? "critical" : "warning",
      message: `${missing.length} of ${current.sitemapTotal} sitemap pages are not indexed: ${missing
        .slice(0, 5)
        .map((page) => page.path)
        .join(", ")}${missing.length > 5 ? "…" : ""}`,
    });
  }

  if (current.sitemapSubmitted > 0 && current.sitemapSubmitted !== current.sitemapTotal) {
    alerts.push({
      severity: "warning",
      message: `Search Console read ${current.sitemapSubmitted} URLs from the sitemap but the app publishes ${current.sitemapTotal}. Re-submit the sitemap.`,
    });
  }

  return alerts;
}
