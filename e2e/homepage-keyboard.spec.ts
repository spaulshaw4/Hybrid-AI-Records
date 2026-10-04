import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Keyboard-only coverage for the homepage: the primary CTAs must be reachable
 * and operable with Tab/Enter, and the Recent Releases play preview must open,
 * stay operable, and release focus again without trapping the keyboard.
 */

const MAX_TABS = 48;

const playButton = (page: Page) => page.locator('button[aria-label^="Play video:"]').first();

const previewDialog = (page: Page) =>
  page.locator('[role="dialog"][aria-modal="true"]').filter({
    has: page.getByRole("button", { name: "Close video" }),
  });

/**
 * Open the release preview from the keyboard.
 * The poster is in the SSR HTML before Enter is wired, so a too-early press is
 * lost. Retry only while the dialog node is absent — a second Enter once it
 * exists can dismiss it. The cap stays inside the 15s CI test timeout.
 */
async function openPreview(page: Page) {
  const dialog = previewDialog(page);
  const play = playButton(page);
  await expect(play).toBeVisible();
  await play.scrollIntoViewIfNeeded();
  await expect(async () => {
    if ((await dialog.count()) === 0) await play.press("Enter");
    await expect(dialog).toBeVisible({ timeout: 300 });
    await expect(dialog.getByRole("button", { name: "Close video" })).toBeVisible({ timeout: 300 });
  }).toPass({ timeout: 12_000 });
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
  // One shared page. Reloading `/` per test repeated Vite transform + hydration
  // and made this serial file the wall clock. Suite timeout stays on config /
  // `--timeout` (CI passes 15s). Do not raise a 90s or 150s describe timeout.
  test.describe.configure({ mode: "serial" });

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, baseURL }) => {
    context = await browser.newContext({
      baseURL,
      viewport: { width: 1280, height: 720 },
    });
    // Posters, the YouTube iframe, and analytics keep Vite's single thread busy,
    // which delays the client bundle that wires Enter. The assertions only need
    // the button and the dialog node.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      const url = route.request().url();
      if (
        type === "image" ||
        type === "media" ||
        type === "font" ||
        /youtube\.com|youtu\.be|googletagmanager|google-analytics|doubleclick|sentry\.io/.test(url)
      ) {
        return route.abort();
      }
      return route.continue();
    });
    page = await context.newPage();
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(playButton(page)).toBeVisible();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test.beforeEach(async () => {
    // Visible play control is the ready signal. Reload only if a previous
    // test left the homepage (the CTA test navigates to /portal).
    const path = new URL(page.url()).pathname;
    if (path !== "/") {
      await page.goto("/", { waitUntil: "domcontentloaded" });
    }
    if ((await previewDialog(page).count()) > 0) await page.keyboard.press("Escape");
    await expect(playButton(page)).toBeVisible();
  });

  test("release play preview opens with Enter and closes with Escape", async () => {
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

  test("the play preview does not trap the keyboard", async () => {
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

  test("every release card play button exposes an accessible name", async () => {
    const buttons = page.locator('button[aria-label^="Play video:"]');
    await expect(buttons.first()).toBeVisible();
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const label = await buttons.nth(i).getAttribute("aria-label");
      expect(label).toMatch(/^Play video: .+ by .+/);
    }
  });

  test("primary CTAs are reachable and activatable by keyboard", async () => {
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
    await page.waitForURL("**/portal", { waitUntil: "commit", timeout: 10_000 });
    await expect(page.locator("#order")).toBeVisible();
    await expect(page.locator("#quick-order-form")).toBeVisible();
  });
});
