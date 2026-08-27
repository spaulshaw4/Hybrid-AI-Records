import { expect, test } from "@playwright/test";
import {
  ORDER_CTA,
  ORDER_FIRST_FIELD,
  ORDER_VISIBLE_MS,
  expectFieldClearOfStickyHeader,
  expectOrderCtaFocused,
  expectOrderFieldFocused,
  expectUrlIncludes,
  gotoPortal,
} from "./helpers/order-focus";

/**
 * prefers-reduced-motion coverage: with animations minimized the reveal/scroll
 * choreography changes, so deep-link scrolling, focus handoff, and history
 * focus restoration must all still work.
 */

const CTA = ORDER_CTA;
const FIRST_FIELD = ORDER_FIRST_FIELD;

test.use({ reducedMotion: "reduce" });

test.describe("Reduced motion — order deep link and focus", () => {
  test.describe.configure({ timeout: 90_000 });

  // Belt and braces: some sandbox Chromium builds ignore the context-level
  // preference, so emulate it on the page too before any navigation.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("the reduced-motion preference is actually applied", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect
      .poll(
        async () =>
          page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  test("deep link to /#order scrolls and focuses the first field", async ({ page }) => {
    await gotoPortal(page, "/portal#order");
    const field = page.locator(FIRST_FIELD);
    await expectOrderFieldFocused(page);
    await expectFieldClearOfStickyHeader(page, field);
  });

  test("deep link with a package slug prefills and still focuses", async ({ page }) => {
    await gotoPortal(page, "/portal?package=foundation#order");
    await expectOrderFieldFocused(page);
    // The alias is canonicalized to the real package slug (async on mount).
    await expectUrlIncludes(page, "package=distribution-release");
    await expectUrlIncludes(page, "#order");
  });

  test("CTA click focuses the field and Escape restores focus", async ({ page }) => {
    await gotoPortal(page);
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await cta.click();

    await expectOrderFieldFocused(page);
    await expectUrlIncludes(page, "#order");

    await page.keyboard.press("Escape");
    await expectOrderCtaFocused(page, cta);
  });

  test("back/forward restores focus on both sides of #order", async ({ page }) => {
    await gotoPortal(page);
    const cta = page.locator(CTA).first();
    await expect(cta).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await cta.click();
    await expectOrderFieldFocused(page);

    await page.goBack();
    await expectOrderCtaFocused(page, cta);
    await expect
      .poll(() => page.url(), { timeout: ORDER_VISIBLE_MS })
      .not.toContain("#order");

    await page.goForward();
    await expectOrderFieldFocused(page);
  });

  test("release play preview opens and closes without animation stalls", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator("main#main-content, main").first().waitFor({
      state: "visible",
      timeout: ORDER_VISIBLE_MS,
    });

    const dialog = page.locator('[role="dialog"][aria-modal="true"]').filter({
      has: page.getByRole("button", { name: "Close video" }),
    });
    const play = page.locator('button[aria-label^="Play video:"]').first();
    await expect(play).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await play.scrollIntoViewIfNeeded();

    // Retry: home catalog cards can remount once hydration finishes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await play.press("Enter").catch(() => undefined);
      await page.waitForURL(/\?v=/, { timeout: 2_500 }).catch(() => undefined);
      if (await dialog.isVisible().catch(() => false)) break;
      await play.click({ force: true });
      await page.waitForURL(/\?v=/, { timeout: 5_000 }).catch(() => undefined);
      if (await dialog.isVisible().catch(() => false)) break;
      await page.waitForTimeout(250);
    }

    await expect(dialog).toBeVisible({ timeout: ORDER_VISIBLE_MS });
    await expect(dialog.locator(".modal-panel-solid").first()).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
