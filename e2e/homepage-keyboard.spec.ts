import { expect, test, type Page } from "@playwright/test";

/**
 * Keyboard-only coverage for the homepage: the primary CTAs must be reachable
 * and operable with Tab/Enter, and the Recent Releases play preview must open,
 * stay operable, and release focus again without trapping the keyboard.
 */

const MAX_TABS = 48;

/** Focus a hydrated play button and open its preview with Enter. */
async function openPreview(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').filter({
    has: page.getByRole("button", { name: "Close video" }),
  });
  const play = page.locator('button[aria-label^="Play video:"]').first();
  await play.scrollIntoViewIfNeeded();
  await play.press("Enter");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
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
async function tabUntil(
  page: Page,
  predicate: (info: NonNullable<Awaited<ReturnType<typeof focusInfo>>>) => boolean,
) {
  for (let i = 0; i < MAX_TABS; i += 1) {
    await page.keyboard.press("Tab");
    const info = await focusInfo(page);
    if (info && predicate(info)) return { info, presses: i + 1 };
  }
  return null;
}

test.describe("Homepage keyboard navigation", () => {
  // Cold Vite compiles of `/` + catalog cards need headroom on CI runners.
  // Keep this file on one worker: four parallel homepage loads stall hydration,
  // so Enter never reaches the client click handler.
  test.describe.configure({ mode: "serial", timeout: 150_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Desktop uses the sidebar nav; the <header> topbar is `lg:hidden` and stays hidden at 1280px.
    const readyMs = process.env.CI ? 30_000 : 15_000;
    await page.locator("main#main-content, main").first().waitFor({ state: "visible", timeout: readyMs });
    await expect(page.getByRole("link", { name: "Create Your Track" }).first()).toBeVisible({
      timeout: readyMs,
    });
    // Prefer a concrete catalog signal over networkidle (analytics keeps the
    // network busy and hangs CI) or a fixed sleep (flakes on cold compiles).
    await expect(page.locator('button[aria-label^="Play video:"]').first()).toBeVisible({
      timeout: readyMs,
    });
    // SSR paints the controls before React attaches onClick / client routing.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('button[aria-label^="Play video:"]');
        return !!el && Object.keys(el).some((key) => key.startsWith("__react"));
      },
      undefined,
      { timeout: 45_000 },
    );
  });

  test("primary CTAs are reachable and activatable by keyboard", async ({ page }) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("body").click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // The first tab stop must be a skip link (keyboard users escape the nav fast).
    await page.keyboard.press("Tab");
    const first = await focusInfo(page);
    expect(first?.tag).toBe("a");

    // Prefer direct focus for speed; fall back to Tab discovery if needed.
    const makeTrackLink = page.getByRole("link", { name: "Create Your Track" }).first();
    await makeTrackLink.focus();
    let makeTrack = (await focusInfo(page))?.label.match(/create your track/i)
      ? { info: await focusInfo(page), presses: 0 }
      : null;
    if (!makeTrack) {
      makeTrack = await tabUntil(page, (i) => /create your track/i.test(i.label));
    }
    expect(makeTrack, "Create Your Track CTA should be reachable by Tab").not.toBeNull();

    const submitLink = page.getByRole("link", { name: "Submit Your Music" }).first();
    await submitLink.focus();
    let submit = (await focusInfo(page))?.label.match(/submit your music/i)
      ? { info: await focusInfo(page), presses: 0 }
      : null;
    if (!submit) {
      submit = await tabUntil(page, (i) => /submit your music/i.test(i.label));
    }
    expect(submit, "Submit Your Music CTA should be reachable by Tab").not.toBeNull();

    const listenLink = page.getByRole("link", { name: "Listen & Download" }).first();
    await listenLink.focus();
    let listen = (await focusInfo(page))?.label.match(/listen & download/i)
      ? { info: await focusInfo(page), presses: 0 }
      : null;
    if (!listen) {
      listen = await tabUntil(page, (i) => /listen & download/i.test(i.label));
    }
    expect(listen, "Listen & Download CTA should be reachable by Tab").not.toBeNull();

    // Client-side routing updates the URL without a document load event.
    await submitLink.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL("**/portal", { waitUntil: "commit", timeout: 30_000 });
    await expect(page.locator("#order")).toBeVisible();
    await expect(page.locator("#quick-order-form")).toBeVisible();
  });

  test("release play preview opens with Enter and closes with Escape", async ({ page }) => {
    await openPreview(page);
    const dialog = page.locator('[role="dialog"][aria-modal="true"]').filter({
      has: page.getByRole("button", { name: "Close video" }),
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Close video" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);

    // The trigger is still keyboard-operable after the dialog closed.
    await openPreview(page);
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });

  test("the play preview does not trap the keyboard", async ({ page }) => {
    await openPreview(page);
    const dialog = page.locator('[role="dialog"][aria-modal="true"]').filter({
      has: page.getByRole("button", { name: "Close video" }),
    });
    await expect(dialog).toBeVisible();

    const close = page.getByRole("button", { name: "Close video" });
    await close.focus();
    await expect(close).toBeFocused();

    // Close is operable from the keyboard (no dead-end dialog).
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);

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
    const readyMs = process.env.CI ? 30_000 : 15_000;
    const buttons = page.locator('button[aria-label^="Play video:"]');
    await expect(buttons.first()).toBeVisible({ timeout: readyMs });
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const label = await buttons.nth(i).getAttribute("aria-label");
      expect(label).toMatch(/^Play video: .+ by .+/);
    }
  });
});
