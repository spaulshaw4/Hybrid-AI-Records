import { describe, expect, it } from "vitest";

import { PORTAL_MENU } from "@/lib/portal-tabs";
import { MERCH_URL, shouldShowSiteNav, SITE_NAV } from "@/lib/site-nav";

describe("site nav", () => {
  it("uses the portal menu as the only five destinations", () => {
    expect(PORTAL_MENU.map((item) => item.id)).toEqual([
      "create",
      "catalog_merch",
      "plans",
      "radio",
      "distribution",
    ]);
    expect(PORTAL_MENU.map((item) => item.short)).toEqual([
      "Create",
      "Catalog",
      "Plans",
      "Radio",
      "Distro",
    ]);
    expect(PORTAL_MENU.map((item) => item.label)).toEqual([
      "CREATE YOUR TRACK",
      "CATALOG & MERCH",
      "PLANS & TOKENS",
      "HYBRID AI RADIO",
      "DISTRIBUTION & VIDEO PACKAGES",
    ]);
    expect(PORTAL_MENU.map((item) => item.query)).toEqual([
      "create",
      "catalog",
      "plans",
      "radio",
      "distribution",
    ]);
    expect(SITE_NAV).toBe(PORTAL_MENU);
  });

  it("keeps merch inside the catalog tab as an external store", () => {
    expect(PORTAL_MENU.some((item) => item.label.includes("MERCH") && item.id !== "catalog_merch")).toBe(
      false,
    );
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
