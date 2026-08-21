import { describe, expect, it } from "vitest";
import { isSiteNavActive, shouldShowSiteNav, SITE_NAV } from "@/lib/site-nav";

describe("site nav", () => {
  it("keeps the five primary destinations in order", () => {
    expect(SITE_NAV.map((item) => item.id)).toEqual([
      "make-track",
      "catalog",
      "merch",
      "podcast",
      "packages",
    ]);
  });

  it("hides chrome on admin and auth", () => {
    expect(shouldShowSiteNav("/admin/review")).toBe(false);
    expect(shouldShowSiteNav("/auth")).toBe(false);
    expect(shouldShowSiteNav("/engine")).toBe(true);
  });

  it("marks Make Your Track active on the engine workspace", () => {
    const item = SITE_NAV.find((entry) => entry.id === "make-track")!;
    expect(isSiteNavActive(item, "/engine", {}, "")).toBe(true);
    expect(isSiteNavActive(item, "/", {}, "")).toBe(false);
  });
});
