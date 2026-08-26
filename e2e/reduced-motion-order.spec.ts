import { expect, test, type Page } from "@playwright/test";

/**
 * prefers-reduced-motion coverage: with animations minimized the reveal/scroll
 * choreography changes, so deep-link scrolling, focus handoff, and history
 * focus restoration must all still work.
 */

const CTA = 'a[aria-controls="quick-order-form"]';
const FIRST_FIELD = "#qo-artist";

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? "");

const headerHeight = (page: Page) =>
  page.evaluate(() => {
    const header = document.querySelector("header");
    return header instanceof HTMLElement ? header.offsetHeight : 0;
  });

test.use({ reducedMotion: "reduce" });

test.describe("Reduced motion — order deep link and focus", () => {
  // Belt and braces: some sandbox Chromium builds ignore the context-level
  // preference, so emulate it on the page too before any navigation.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("the reduced-motion preference is actually applied", async ({ page }) => {
    await page.goto("/");
    const reduced = await page.evaluate(
      () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    expect(reduced).toBe(true);
  });

  test("deep link to /#order scrolls and focuses the first field", async ({ page }) => {
    await page.goto("/portal#order");
    const field = page.locator(FIRST_FIELD);
    await expect(field).toBeFocused();

    const [box, header] = await Promise.all([field.boundingBox(), headerHeight(page)]);
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(header);
    expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  });

  test("deep link with a package slug prefills and still focuses", async ({ page }) => {
    await page.goto("/portal?package=foundation#order");
    await expect(page.locator(FIRST_FIELD)).toBeFocused();
    // The alias is canonicalized to the real package slug.
    expect(page.url()).toContain("package=distribution-release");
    expect(page.url()).toContain("#order");
  });

  test("CTA click focuses the field and Escape restores focus", async ({ page }) => {
    await page.goto("/portal");
    const cta = page.locator(CTA).first();
    await cta.click();

    await expect(page.locator(FIRST_FIELD)).toBeFocused();
    expect(page.url()).toContain("#order");

    await page.keyboard.press("Escape");
    await expect.poll(() => activeId(page)).not.toBe("qo-artist");
    await expect(cta).toBeFocused();
  });

  test("back/forward restores focus on both sides of #order", async ({ page }) => {
    await page.goto("/portal");
    const cta = page.locator(CTA).first();
    await cta.click();
    await expect(page.locator(FIRST_FIELD)).toBeFocused();

    await page.goBack();
    await expect(cta).toBeFocused();
    expect(page.url()).not.toContain("#order");

    await page.goForward();
    await expect(page.locator(FIRST_FIELD)).toBeFocused();
  });

  test("release play preview opens and closes without animation stalls", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(400);

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    const play = page.locator('button[aria-label^="Play video:"]').first();
    await play.scrollIntoViewIfNeeded();
    await play.focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
