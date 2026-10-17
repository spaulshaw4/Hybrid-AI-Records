import { CreditCard, Disc, Film, Radio, Sparkles } from "lucide-react";
import { describe, expect, it } from "vitest";

import { resolvePortalTab } from "@/lib/portal-tabs";
import { isSiteNavEntryActive, MERCH_URL, shouldShowSiteNav, SITE_NAV } from "@/lib/site-nav";

describe("site nav", () => {
  it("exports one canonical SITE_NAV with icons and five destinations", () => {
    expect(SITE_NAV.map((item) => item.label)).toEqual([
      "Create Your Track",
      "Catalog & Merch",
      "Plans & Tokens",
      "Hybrid AI Radio",
      "Distribution & Video Packages",
    ]);
    expect(SITE_NAV.map((item) => item.href)).toEqual([
      "/portal?tab=create",
      "/portal?tab=catalog",
      "/portal?tab=plans",
      "/portal?tab=radio",
      "/portal?tab=distribution",
    ]);
    expect(SITE_NAV.map((item) => item.tab)).toEqual([
      "create",
      "catalog",
      "plans",
      "radio",
      "distribution",
    ]);
    expect(SITE_NAV.map((item) => item.icon)).toEqual([Sparkles, Disc, CreditCard, Radio, Film]);
    expect(SITE_NAV.map((item) => resolvePortalTab(item.tab))).toEqual([
      "create",
      "catalog_merch",
      "plans",
      "radio",
      "distribution",
    ]);
  });

  it("lights catalog for catalog_merch and distribution for the video alias", () => {
    const catalog = SITE_NAV.find((item) => item.tab === "catalog");
    const distribution = SITE_NAV.find((item) => item.tab === "distribution");
    const plans = SITE_NAV.find((item) => item.tab === "plans");
    expect(catalog).toBeDefined();
    expect(distribution).toBeDefined();
    expect(plans).toBeDefined();
    if (!catalog || !distribution || !plans) return;

    expect(isSiteNavEntryActive(catalog, "catalog_merch", true)).toBe(true);
    expect(isSiteNavEntryActive(catalog, "merch", true)).toBe(true);
    expect(isSiteNavEntryActive(catalog, "catalog", true)).toBe(true);
    expect(isSiteNavEntryActive(distribution, "video", true)).toBe(true);
    expect(isSiteNavEntryActive(distribution, "distribution", true)).toBe(true);
    expect(isSiteNavEntryActive(plans, "tokens", true)).toBe(false);
    expect(isSiteNavEntryActive(catalog, "catalog_merch", false)).toBe(false);
  });

  it("keeps merch inside the catalog tab as an external store", () => {
    expect(SITE_NAV.some((item) => item.label.includes("Merch") && item.tab !== "catalog")).toBe(false);
    expect(SITE_NAV.find((item) => item.tab === "plans")?.href).toBe("/portal?tab=plans");
    expect(SITE_NAV.find((item) => item.tab === "distribution")?.href).toBe("/portal?tab=distribution");
    expect(MERCH_URL).toBe("https://hybrid-ai-records-llc.printful.me");
  });

  it("hides chrome on admin and auth", () => {
    expect(shouldShowSiteNav("/admin/review")).toBe(false);
    expect(shouldShowSiteNav("/auth")).toBe(false);
    expect(shouldShowSiteNav("/engine")).toBe(true);
    expect(shouldShowSiteNav("/")).toBe(true);
    expect(shouldShowSiteNav("/portal")).toBe(true);
  });
});
