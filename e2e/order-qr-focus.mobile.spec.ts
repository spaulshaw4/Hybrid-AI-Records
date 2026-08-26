import { expect, test, type Page } from "@playwright/test";

/**
 * Mobile/touch contract for the QR panel.
 *
 * Phones have no Escape key, so every "Escape alternative" must restore focus
 * to the QR toggle on tap:
 *   - the panel's Close (overlay) button
 *   - tapping the QR toggle again
 *   - tapping outside the panel
 * Focus return matters on touch too: VoiceOver/TalkBack keep their cursor on
 * the element that owns DOM focus.
 */

const PANEL = '[data-testid="share-link-qr"]';
const DL_PNG = '[data-testid="share-link-qr-download"]';

const toggle = (page: Page) =>
  page.getByRole("button", { name: /qr code for this order link/i }).first();
const closeBtn = (page: Page) =>
  page.getByRole("button", { name: /close the qr code/i }).first();

async function open(page: Page) {
  await page.goto("/portal?package=visual-push#order", { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  // Wait for the draft-restore effect to settle on its final package value,
  // otherwise a late re-render remounts the panel and drops focus mid-test.
  await expect
    .poll(async () => page.locator("#qo-package").inputValue(), { timeout: 15_000 })
    .toMatch(/visual push/i);
  await expect(toggle(page)).toBeVisible();
  await page.waitForTimeout(1000);
}

/** Taps the toggle until the panel is mounted AND focused (mobile layout settles late). */
async function openPanel(page: Page) {
  const panel = page.locator(PANEL);
  await expect(async () => {
    if ((await panel.count()) > 0 && !(await panel.evaluate((el) => el === document.activeElement))) {
      // A late remount stole focus — close and reopen so the open effect reruns.
      await toggle(page).tap();
      await expect(panel).toHaveCount(0, { timeout: 2000 });
    }
    if ((await panel.count()) === 0) {
      await toggle(page).scrollIntoViewIfNeeded();
      await toggle(page).tap();
    }
    await expect(panel).toBeVisible({ timeout: 1000 });
    await expect(panel).toBeFocused({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
  return panel;
}


async function expectClosedWithFocusOnToggle(page: Page) {
  await expect(page.locator(PANEL)).toHaveCount(0);
  await expect(toggle(page)).toBeFocused();
  await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
}

test.describe("QR panel — mobile tap dismissal returns focus to the toggle", () => {
  test("tapping the Close button closes the panel and refocuses the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    await closeBtn(page).tap();
    await expectClosedWithFocusOnToggle(page);
  });

  test("tapping the toggle again closes the panel and keeps focus on it", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    await toggle(page).tap();
    await expectClosedWithFocusOnToggle(page);
  });

  test("tapping outside the panel closes it and returns focus to the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);

    // Tap a neutral spot well away from the panel and the toggle.
    await page.locator("#qo-artist").scrollIntoViewIfNeeded();
    await page.locator("#qo-artist").tap();
    await expectClosedWithFocusOnToggle(page);
  });

  test("reopening after a tap dismissal still traps focus inside the panel", async ({ page }) => {
    test.slow();
    await open(page);
    await openPanel(page);
    await closeBtn(page).tap();
    await expectClosedWithFocusOnToggle(page);

    // Second open must behave identically — no stale focus or duplicate panel.
    const panel = await openPanel(page);
    await panel.locator(DL_PNG).tap();
    const inside = await page.evaluate(
      (sel) => document.querySelector(sel)?.contains(document.activeElement) ?? false,
      PANEL,
    );
    expect(inside).toBe(true);

    await closeBtn(page).tap();
    await expectClosedWithFocusOnToggle(page);
  });
});
