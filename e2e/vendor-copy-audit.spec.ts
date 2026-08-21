import { expect, test } from "@playwright/test";

import { findVendorLeaks } from "../src/lib/vendor-audit";

/**
 * Rendered-DOM half of the vendor audit: crawls every public page and asserts
 * no provider/model name is visible to a visitor.
 */
const ROUTES = [
  "/",
  "/portal",
  "/engine",
  "/artists",
  "/studio",
  "/tokens",
  "/licensing",
  "/privacy",
  "/veteran-certification",
  "/cinematic-studio",
  "/start",
];

for (const route of ROUTES) {
  test(`no vendor names visible on ${route}`, async ({ page }) => {
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    const text = await page.evaluate(() => document.body.innerText ?? "");
    const leaks = findVendorLeaks(text);

    expect(
      leaks.map((l) => `${l.term}: ${l.excerpt}`),
      `Vendor names visible on ${route}`,
    ).toEqual([]);
  });
}
