import { expect, test, type Page } from "@playwright/test";

/**
 * Focus-trap contract for the QR panel:
 *  - Tab from the last control wraps to the first, Shift+Tab from the first
 *    wraps to the last, and focus never escapes the panel.
 *  - Focus returns to the QR toggle no matter how the panel is dismissed:
 *    Escape, the Close button, re-clicking the toggle, or an outside click.
 */

const PANEL = '[data-testid="share-link-qr"]';
const SIZE = '[data-testid="share-link-qr-size"]';
const LEVEL = '[data-testid="share-link-qr-level"]';
const DL_PNG = '[data-testid="share-link-qr-download"]';
const DL_SVG = '[data-testid="share-link-qr-download-svg"]';

const toggle = (page: Page) =>
  page.getByRole("button", { name: /qr code for this order link/i }).first();
const closeBtn = (page: Page) =>
  page.getByRole("button", { name: /close the qr code/i }).first();

async function open(page: Page) {
  await page.goto("/?package=visual-push#order", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  await expect(toggle(page)).toBeVisible();
  // Let any late draft-restore effect settle so the panel can't remount mid-test.
  await page.waitForTimeout(1500);
}

/** Clicks the toggle until the panel is actually mounted (layout can still settle). */
async function openPanel(page: Page) {
  const panel = page.locator(PANEL);
  await expect(async () => {
    if ((await panel.count()) === 0) await toggle(page).click();
    await expect(panel).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  // The panel autofocuses on open, but a late draft-restore effect can steal
  // focus under load; settle it deterministically before asserting the trap.
  await expect(async () => {
    const inside = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return !!el && !!document.activeElement && el.contains(document.activeElement);
    }, PANEL);
    if (!inside) await panel.focus();
    await expect(panel).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  return panel;
}


/** Reports which known control (if any) currently holds focus. */
async function focusedTestId(page: Page) {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.getAttribute("data-testid") ?? null,
  );
}

test.describe("QR panel — focus trap and focus return", () => {
  test("Tab cycles forward through the panel controls and wraps to the first", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    // Walk forward from the panel container through every control.
    await page.keyboard.press("Tab");
    await expect(page.locator(SIZE)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(LEVEL)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(DL_PNG)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.locator(DL_SVG)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(closeBtn(page)).toBeFocused();

    // Past the last control the trap wraps back to the first one.
    await page.keyboard.press("Tab");
    await expect(page.locator(SIZE)).toBeFocused();

    // Focus never left the panel.
    const inside = await page.evaluate(
      (sel) => document.querySelector(sel)!.contains(document.activeElement),
      PANEL,
    );
    expect(inside).toBe(true);
  });

  test("Shift+Tab from the first control wraps to the last and stays trapped", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    await page.locator(SIZE).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(closeBtn(page)).toBeFocused();

    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(DL_SVG)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(DL_PNG)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(LEVEL)).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(SIZE)).toBeFocused();

    expect(await focusedTestId(page)).toBe("share-link-qr-size");
  });

  test("a full Tab loop never lands outside the panel", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        (sel) => document.querySelector(sel)!.contains(document.activeElement),
        PANEL,
      );
      expect(inside, `focus escaped the panel on Tab #${i + 1}`).toBe(true);
    }
  });

  test("Escape closes the panel and returns focus to the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    const panel = await openPanel(page);

    await page.locator(DL_PNG).focus();
    await page.keyboard.press("Escape");

    await expect(panel).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("the Close button returns focus to the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    const panel = await openPanel(page);

    await closeBtn(page).click();

    await expect(panel).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking the toggle again closes the panel and keeps focus on the toggle", async ({
    page,
  }) => {
    test.slow();
    await open(page);
    const panel = await openPanel(page);

    await toggle(page).click();

    await expect(panel).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("clicking outside closes the panel and restores focus to the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    const panel = await openPanel(page);

    // Click a neutral spot well away from the panel and the toggle.
    await page.locator("#qo-artist").click();

    await expect(panel).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });
});
