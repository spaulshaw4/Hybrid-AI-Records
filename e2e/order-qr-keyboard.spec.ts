import { expect, test, type Page } from "@playwright/test";

/**
 * Keyboard-only journey through the QR panel: reach and activate the toggle
 * with Enter/Space, land focus inside the panel, Tab through every control in
 * DOM order, and get focus returned to the toggle on close (Escape *and* the
 * Close button). No mouse is used anywhere in this spec.
 */

const PANEL = '[data-testid="share-link-qr"]';
const SIZE = '[data-testid="share-link-qr-size"]';
const LEVEL = '[data-testid="share-link-qr-level"]';
const DL_PNG = '[data-testid="share-link-qr-download"]';
const DL_SVG = '[data-testid="share-link-qr-download-svg"]';

const toggle = (page: Page) => page.getByRole("button", { name: /qr code for this order link/i }).first();

async function open(page: Page, entry = "/?package=visual-push#order") {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  await expect(page.locator("#qo-package")).toHaveValue("Production & Visual Push", {
    timeout: 30_000,
  });
  await expect(toggle(page)).toBeVisible();
  // Let any late draft-restore effect settle so the panel can't remount mid-test.
  await page.waitForTimeout(500);
}

/** Tabs from a nearby field until the QR toggle holds focus — never clicks. */
async function focusToggleByKeyboard(page: Page) {
  const btn = toggle(page);
  await btn.scrollIntoViewIfNeeded();
  await page.locator("#qo-link").focus();
  await expect(async () => {
    await page.keyboard.press("Tab");
    await expect(btn).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

test.describe("QR panel — keyboard-only navigation", () => {
  test("Enter opens the panel, focus moves into it, Escape returns focus", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);

    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");

    const panel = page.locator(PANEL);
    await expect(panel).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    // The panel itself takes focus so a screen reader lands on its label.
    await expect(panel).toBeFocused();
    await expect(panel).toHaveAttribute("tabindex", "-1");

    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(toggle(page)).toBeFocused();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
  });

  test("Space also toggles the panel open and closed", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);

    await page.keyboard.press(" ");
    await expect(page.locator(PANEL)).toBeVisible();

    // Focus is on the panel; Shift+Tab walks back to the toggle to close it.
    await page.keyboard.press("Shift+Tab");
    await expect(toggle(page)).toBeFocused();
    await page.keyboard.press(" ");
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
  });

  test("Tab visits every panel control in order with a visible focus ring", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(PANEL)).toBeFocused();

    const order = [SIZE, LEVEL, DL_PNG, DL_SVG];
    for (const selector of order) {
      await page.keyboard.press("Tab");
      await expect(page.locator(selector)).toBeFocused();

      const ring = await page.locator(selector).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          outlineStyle: s.outlineStyle,
          outlineWidth: parseFloat(s.outlineWidth || "0"),
          boxShadow: s.boxShadow,
        };
      });
      expect(
        (ring.outlineStyle !== "none" && ring.outlineWidth > 0) ||
          (ring.boxShadow !== "none" && ring.boxShadow !== ""),
      ).toBe(true);
    }

    // Last stop inside the panel is the Close button.
    await page.keyboard.press("Tab");
    const close = page.getByRole("button", { name: /close the qr code/i });
    await expect(close).toBeFocused();
  });

  test("Escape fired from a control inside the panel still returns focus", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(PANEL)).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.locator(SIZE)).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(toggle(page)).toBeFocused();
  });

  test("activating Close with the keyboard returns focus to the toggle", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(PANEL)).toBeFocused();

    const close = page.getByRole("button", { name: /close the qr code/i });
    await close.focus();
    await page.keyboard.press("Enter");

    await expect(page.locator(PANEL)).toBeHidden();
    await expect(toggle(page)).toBeFocused();

    // Re-opening from the returned focus position works without a mouse.
    await page.keyboard.press("Enter");
    await expect(page.locator(PANEL)).toBeFocused();
  });

  test("changing size and level from the keyboard keeps focus on the select", async ({ page }) => {
    test.slow();
    await open(page);
    await focusToggleByKeyboard(page);
    await page.keyboard.press("Enter");
    await expect(page.locator(PANEL)).toBeFocused();

    await page.keyboard.press("Tab");
    const size = page.locator(SIZE);
    await expect(size).toBeFocused();
    await size.selectOption("large");
    await expect(size).toHaveValue("large");
    await expect(size).toBeFocused();

    await page.keyboard.press("Tab");
    const level = page.locator(LEVEL);
    await expect(level).toBeFocused();
    await level.selectOption("H");
    await expect(level).toHaveValue("H");
    await expect(level).toBeFocused();

    // The panel stays open and the QR is still rendered after both changes.
    await expect(page.locator(`${PANEL} svg`).first()).toBeVisible();
  });
});
