import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * The share link must be usable without a mouse and legible to a screen
 * reader: the button carries a descriptive accessible name, is reachable and
 * activatable from the keyboard (Enter *and* Space), shows a visible focus
 * ring, keeps focus after copying, announces success through a polite live
 * region, and — when the clipboard is blocked — exposes a `role="status"`
 * fallback that receives focus with the URL selected for manual copying.
 */

const COPY_BUTTON = "button:has-text('Copy Share Link'), button:has-text('Link Copied')";
const FALLBACK = '[data-testid="share-link-fallback"]';
const MANUAL_INPUT = "#manual-share-link";

const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

/** Injects axe and scans one subtree, returning "id: help" strings. */
async function scan(page: Page, selector: string): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async (sel) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    const results = await axe.run(sel, { resultTypes: ["violations"] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.violations.map((v: any) => `${v.id}: ${v.help}`);
  }, selector);
}

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry = "/portal?package=visual-push#order") {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#qo-package")).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Wait for the URL prefill to land: until it does the button still carries the
  // default tier in its accessible name and can remount mid-interaction.
  await expect(page.locator("#qo-package")).toHaveValue("Production & Visual Push", {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
}

/** Keyboard-focuses the copy button without ever using the mouse. */
async function focusByKeyboard(page: Page) {
  const btn = copyButton(page);
  await btn.scrollIntoViewIfNeeded();
  // Land keyboard focus on the preceding field, then Tab until we reach it.
  await page.locator("#qo-link").focus();
  await expect(async () => {
    await page.keyboard.press("Tab");
    await expect(btn).toBeFocused({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
}

/** Blocks every clipboard path so the manual fallback renders. */
async function blockClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = () => false;
    window.prompt = () => null;
  });
}

test.describe("Copy share link — keyboard accessibility and announcements", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("button exposes a descriptive accessible name including the tier", async ({ page }) => {
    await open(page);
    const name = await copyButton(page).getAttribute("aria-label");
    expect(name).toMatch(/copy share link/i);
    expect(name).toMatch(/production & visual push/i);
    // Not a bare icon button: the visible label is text, not an image.
    await expect(copyButton(page)).toContainText(/copy share link/i);
  });

  test("reachable by Tab with a visible focus ring", async ({ page }) => {
    test.slow();
    await open(page);
    await focusByKeyboard(page);

    const ring = await copyButton(page).evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        outlineStyle: s.outlineStyle,
        outlineWidth: parseFloat(s.outlineWidth || "0"),
        boxShadow: s.boxShadow,
      };
    });
    const visible =
      (ring.outlineStyle !== "none" && ring.outlineWidth > 0) ||
      (ring.boxShadow !== "none" && ring.boxShadow !== "");
    expect(visible).toBe(true);
  });

  test("Enter and Space both copy, and focus stays on the button", async ({ page }) => {
    test.slow();
    await open(page);

    for (const key of ["Enter", " "] as const) {
      await focusByKeyboard(page);
      await page.evaluate(() => navigator.clipboard.writeText("")).catch(() => undefined);
      await expect(async () => {
        await page.keyboard.press(key);
        await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 3000 });
      }).toPass({ timeout: 20_000 });

      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toContain("#order");
      // Keyboard users must not be dumped back to the top of the document.
      await expect(copyButton(page)).toBeFocused();
      // Let the 2s label reset run before the next key.
      await expect(copyButton(page)).toContainText(/copy share link/i, { timeout: 6000 });
    }
  });

  test("success is announced through a polite live region inside the button", async ({ page }) => {
    test.slow();
    await open(page);

    const live = copyButton(page).locator("[aria-live='polite']");
    await expect(live).toHaveAttribute("aria-live", "polite");
    // Idle: nothing to announce.
    await expect(live).toHaveText("");

    await focusByKeyboard(page);
    await expect(async () => {
      await page.keyboard.press("Enter");
      await expect(live).toHaveText(/share link copied to clipboard/i, { timeout: 3000 });
    }).toPass({ timeout: 20_000 });

    // The message clears again so a later copy re-announces.
    await expect(live).toHaveText("", { timeout: 6000 });
  });

  test("blocked clipboard exposes a role=status fallback and moves focus to the URL", async ({
    page,
  }) => {
    test.slow();
    await blockClipboard(page);
    await open(page);
    await focusByKeyboard(page);

    await expect(async () => {
      await page.keyboard.press("Enter");
      await expect(page.locator(FALLBACK)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });

    const fallback = page.locator(FALLBACK);
    await expect(fallback).toHaveAttribute("role", "status");
    await expect(fallback).toHaveAttribute("aria-live", "polite");
    await expect(fallback).toContainText(/copying is blocked/i);

    // Focus lands in the field, pre-selected so Ctrl/Cmd+C just works.
    const input = page.locator(MANUAL_INPUT);
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("readonly", "");
    const selected = await input.evaluate(
      (el: HTMLInputElement) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    );
    expect(selected).toBe(await input.inputValue());
    expect(selected).toContain("#order");

    // The field is labelled, not an orphan input.
    const labelFor = page.locator('label[for="manual-share-link"]');
    await expect(labelFor).toBeVisible();

    // And it is still part of the tab order (Shift+Tab returns to the button).
    await page.keyboard.press("Shift+Tab");
    await expect(page.locator(COPY_BUTTON).first()).toBeFocused();
  });

  test("no axe violations in the copy-link region, idle or in fallback state", async ({ page }) => {
    test.slow();
    await blockClipboard(page);
    await open(page);

    expect(await scan(page, "#quick-order-form")).toEqual([]);

    await focusByKeyboard(page);
    await expect(async () => {
      await page.keyboard.press("Enter");
      await expect(page.locator(FALLBACK)).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 20_000 });

    expect(await scan(page, "#quick-order-form")).toEqual([]);
  });
});
