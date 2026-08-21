import { expect, test, type Page } from "@playwright/test";

/**
 * Copying the share link must give visible + announced feedback that then
 * clears itself:
 *   - the button flips to "Link Copied" for ~2s and reverts on its own,
 *   - a polite live region announces the copy for screen readers,
 *   - a sonner toast shows the copied URL and auto-dismisses (3.5s duration).
 */

const PACKAGE_SELECT = "#qo-package";
/** Button label reset delay in CopyOrderLinkButton. */
const COPIED_LABEL_MS = 2000;
/** <Toaster duration> configured in src/routes/__root.tsx. */
const TOAST_DURATION_MS = 3500;

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const toast = (page: Page) => page.locator("[data-sonner-toast]").filter({ hasText: /share link copied/i });

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
}

async function clickCopy(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    try {
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 3000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

test.describe("Copy Share Link — confirmation feedback", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(test.info().project.use.baseURL ?? "http://localhost:8080").origin,
    });
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be blocked; assertions still hold */
      }
    });
  });

  test("shows a toast with the copied URL that auto-dismisses", async ({ page }) => {
    await open(page, "/");
    await clickCopy(page);

    const t = toast(page);
    await expect(t).toBeVisible();

    // The toast repeats the exact URL that landed on the clipboard.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    await expect(t).toContainText(clipboard);

    // It is still up well before its configured duration elapses...
    await page.waitForTimeout(TOAST_DURATION_MS * 0.4);
    await expect(t).toBeVisible();

    // ...and clears itself afterwards without any user action.
    await expect(t).toBeHidden({ timeout: TOAST_DURATION_MS + 3000 });
  });

  test("button confirms then reverts to its idle label", async ({ page }) => {
    await open(page, "/");

    const btn = copyButton(page);
    await expect(btn).toContainText(/copy share link/i);

    await clickCopy(page);
    await expect(btn).toContainText(/link copied/i);

    // Announced politely for assistive tech while the confirmation is up.
    const live = page.locator('[aria-live="polite"]').filter({ hasText: /share link copied to clipboard/i });
    await expect(live).toHaveCount(1);

    // Still confirming shortly after the click...
    await page.waitForTimeout(COPIED_LABEL_MS * 0.4);
    await expect(btn).toContainText(/link copied/i);

    // ...then back to the idle label, with the live region cleared.
    await expect(btn).toContainText(/copy share link/i, { timeout: COPIED_LABEL_MS + 3000 });
    await expect(live).toHaveCount(0);
  });

  test("copying again re-triggers the confirmation", async ({ page }) => {
    await open(page, "/");

    await clickCopy(page);
    // Let the first confirmation expire completely.
    await expect(copyButton(page)).toContainText(/copy share link/i, {
      timeout: COPIED_LABEL_MS + 3000,
    });
    await expect(toast(page)).toBeHidden({ timeout: TOAST_DURATION_MS + 3000 });

    await clickCopy(page);
    await expect(copyButton(page)).toContainText(/link copied/i);
    await expect(toast(page).first()).toBeVisible();
  });
});
