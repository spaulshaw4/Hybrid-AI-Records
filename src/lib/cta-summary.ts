/** Aggregation for anchor-CTA click analytics (no server-only imports). */
export type RawCtaRow = {
  package_slug: string | null;
  visitor_session: string | null;
  details: Record<string, unknown> | null;
};

export type CtaClickStat = {
  packageSlug: string;
  serviceTitle: string;
  clicks: number;
  uniqueVisitors: number;
  sharePct: number;
};

export type CtaClickSummary = {
  windowDays: number;
  totalClicks: number;
  rows: CtaClickStat[];
};

const HOW_IT_WORKS_CTA_ID = "how_it_works_anchor";

export function summarizeCtaClicks(rows: RawCtaRow[], windowDays: number): CtaClickSummary {
  const buckets = new Map<string, { title: string; clicks: number; visitors: Set<string> }>();
  let total = 0;

  for (const row of rows) {
    const details = row.details ?? {};
    if (details["cta"] !== HOW_IT_WORKS_CTA_ID) continue;
    const slug = row.package_slug ?? "unknown";
    const title = typeof details["service_title"] === "string" ? details["service_title"] : slug;
    const bucket = buckets.get(slug) ?? { title, clicks: 0, visitors: new Set<string>() };
    bucket.clicks += 1;
    if (row.visitor_session) bucket.visitors.add(row.visitor_session);
    buckets.set(slug, bucket);
    total += 1;
  }

  const stats: CtaClickStat[] = [...buckets.entries()]
    .map(([packageSlug, b]) => ({
      packageSlug,
      serviceTitle: b.title,
      clicks: b.clicks,
      uniqueVisitors: b.visitors.size,
      sharePct: total === 0 ? 0 : Math.round((b.clicks / total) * 1000) / 10,
    }))
    .sort((a, b) => b.clicks - a.clicks || a.serviceTitle.localeCompare(b.serviceTitle));

  return { windowDays, totalClicks: total, rows: stats };
}
