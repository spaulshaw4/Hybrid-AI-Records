/**
 * Single source of truth for the public pages advertised in sitemap.xml.
 *
 * Both the sitemap route and the admin index-coverage widget read this list so
 * "what we told Google about" and "what we audit" can never drift apart.
 */
import { SERVICES } from "@/lib/services";

export const SITEMAP_BASE_URL = "https://hybrid-ai-records.com";

export type SitemapEntry = {
  path: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: string;
};

// Excluded on purpose (all noindex on the route itself):
//  - /auth, /receipts, /order-status, /checkout/return
//    (personal / transactional lookups)
//  - /dev/*, /admin/*, /mcp, /.lovable/oauth/consent (internal)
export const SITEMAP_ENTRIES: SitemapEntry[] = [
  { path: "/", changefreq: "weekly", priority: "1.0" },
  { path: "/portal", changefreq: "weekly", priority: "0.9" },
  { path: "/start", changefreq: "weekly", priority: "0.9" },
  { path: "/start/onboarding", changefreq: "monthly", priority: "0.6" },
  ...SERVICES.map((s) => ({
    path: `/start/${s.slug}`,
    changefreq: "monthly" as const,
    priority: "0.8",
  })),
  { path: "/veteran-certification", changefreq: "yearly", priority: "0.5" },
];

/** Absolute URLs for every sitemap-listed page, in sitemap order. */
export const sitemapUrls = () => SITEMAP_ENTRIES.map((e) => `${SITEMAP_BASE_URL}${e.path}`);
