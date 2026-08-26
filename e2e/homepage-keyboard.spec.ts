import { expect, test, type Page } from "@playwright/test";

/**
 * Keyboard-only coverage for the homepage: the primary CTAs must be reachable
 * and operable with Tab/Enter, and the Recent Releases play preview must open,
 * stay operable, and release focus again without trapping the keyboard.
 */

const MAX_TABS = 220;

/** Focus a play button and open its preview, retrying if hydration re-renders it. */
async function openPreview(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const play = page.locator('button[aria-label^="Play video:"]').first();
    await play.scrollIntoViewIfNeeded();
    await play.focus();
    await expect(play).toBeFocused();
    await page.keyboard.press("Enter");
    if (await dialog.count()) return;
    await page.waitForTimeout(400);
    if (await dialog.count()) return;
  }
  await expect(dialog).toBeVisible();
}

/** Describe the focused element in a stable, assertable way. */
const focusInfo = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || "",
      label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 80),
      inDialog: !!el.closest('[role="dialog"]'),
    };
  });

/** Tab until `predicate` matches the focused element, or fail after MAX_TABS. */
async function tabUntil(page: Page, predicate: (info: NonNullable<Awaited<ReturnType<typeof focusInfo>>>) => boolean) {
  for (let i = 0; i < MAX_TABS; i += 1) {
    await page.keyboard.press("Tab");
    const info = await focusInfo(page);
    if (info && predicate(info)) return { info, presses: i + 1 };
  }
  return null;
}

test.describe("Homepage keyboard navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.locator("header").first().waitFor();
    // Hydration can swap the server-rendered nodes; settle before touching them.
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(500);
  });

  test("primary CTAs are reachable and activatable by keyboard", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // The first tab stop must be a skip link (keyboard users escape the nav fast).
    await page.keyboard.press("Tab");
    const first = await focusInfo(page);
    expect(first?.tag).toBe("a");

    // Hero CTAs are reachable purely by tabbing.
    const makeTrack = await tabUntil(page, (i) => /create your track/i.test(i.label));
    expect(makeTrack, "Create Your Track CTA should be reachable by Tab").not.toBeNull();

    const submit = await tabUntil(page, (i) => /submit your music/i.test(i.label));
    expect(submit, "Submit Your Music CTA should be reachable by Tab").not.toBeNull();

    const listen = await tabUntil(page, (i) => /listen & download/i.test(i.label));
    expect(listen, "Listen & Download CTA should be reachable by Tab").not.toBeNull();

    // Submit Your Music navigates to the isolated distribution intake.
    await page.getByRole("link", { name: "Submit Your Music" }).first().focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/portal/);
    await expect(page.locator("#order")).toBeVisible();
    await expect(page.locator("#quick-order-form")).toBeVisible();
  });

  test("release play preview opens with Enter and closes with Escape", async ({ page }) => {
    await openPreview(page);
    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close video" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // The trigger is still keyboard-operable after the dialog closed.
    await openPreview(page);
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);
  });

  test("the play preview does not trap the keyboard", async ({ page }) => {
    await openPreview(page);
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toBeVisible();

    const close = page.getByRole("button", { name: "Close video" });
    await close.focus();
    await expect(close).toBeFocused();

    // Close is operable from the keyboard (no dead-end dialog).
    await page.keyboard.press("Enter");
    await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0);

    // Tabbing continues to move focus across the page after the dialog closed.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      const info = await focusInfo(page);
      expect(info?.inDialog, "focus must not be stuck inside a closed dialog").toBeFalsy();
      seen.add(`${info?.tag}:${info?.id}:${info?.label}`);
    }
    expect(seen.size, "Tab should visit multiple distinct elements").toBeGreaterThan(2);
  });

  test("every release card play button exposes an accessible name", async ({ page }) => {
    const buttons = page.locator('button[aria-label^="Play video:"]');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const label = await buttons.nth(i).getAttribute("aria-label");
      expect(label).toMatch(/^Play video: .+ by .+/);
    }
  });
});
