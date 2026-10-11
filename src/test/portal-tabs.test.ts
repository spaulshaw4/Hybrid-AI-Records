import { describe, expect, it } from "vitest";

import { PORTAL_MENU, resolvePortalTab } from "@/lib/portal-tabs";

describe("resolvePortalTab", () => {
  it("keeps the five portal keys and labels the plans tab PLANS & TOKENS", () => {
    expect(PORTAL_MENU.map((item) => item.id)).toEqual([
      "create",
      "catalog_merch",
      "plans",
      "radio",
      "distribution",
    ]);
    expect(PORTAL_MENU.find((item) => item.id === "plans")?.label).toBe("PLANS & TOKENS");
  });

  it("maps legacy tab urls and falls back to create", () => {
    expect(resolvePortalTab(undefined)).toBe("create");
    expect(resolvePortalTab("create")).toBe("create");
    expect(resolvePortalTab("plans")).toBe("plans");
    expect(resolvePortalTab("catalog")).toBe("catalog_merch");
    expect(resolvePortalTab("merch")).toBe("catalog_merch");
    expect(resolvePortalTab("catalog_merch")).toBe("catalog_merch");
    expect(resolvePortalTab("video")).toBe("distribution");
    expect(resolvePortalTab("distribution")).toBe("distribution");
    expect(resolvePortalTab("radio")).toBe("radio");
    expect(resolvePortalTab("nope")).toBe("create");
  });
});