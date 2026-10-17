import { describe, expect, it } from "vitest";

import { resolvePortalTab } from "@/lib/portal-tabs";

describe("resolvePortalTab", () => {
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
    expect(resolvePortalTab("tokens")).toBe("create");
  });
});
