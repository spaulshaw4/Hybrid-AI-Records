import { expect, test, type Page } from "@playwright/test";

/**
 * When every clipboard path is blocked (no `navigator.clipboard`, and
 * `document.execCommand("copy")` returns false — e.g. insecure context,
 * permissions policy, or a locked-down webview) the "Copy Share Link" button
 * must not fail silently. It has to:
 *   1. keep its idle label (never claim "Link Copied"),
 *   2. surface a clear, announced error explaining copying is blocked,
 *   3. expose the exact URL in a focused, pre-selected read-only field,
 *   4. still offer prompt() as an extra manual path.
 */

const PACKAGE_SELECT = "#qo-package";

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const fallback = (page: Page) => page.getByTestId("share-link-fallback");

/** Removes both clipboard paths before any app script runs. */
async function blockClipboard(page: Page) {
  await page.addInitScript(() => {
    // No async Clipboard API at all (as in an insecure context).
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    // Legacy execCommand path refuses the copy.
    document.execCommand = () => false;
    // Record prompt() calls instead of blocking the run on a modal.
    (window as unknown as { __prompts: string[] }).__prompts = [];
    window.prompt = (message?: string, value?: string) => {
      (window as unknown as { __prompts: string[] }).__prompts.push(String(value ?? message ?? ""));
      return null;
    };
  });
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
}

/** Clicks copy; the deep-link scroll can move the button under a first click. */
async function clickCopy(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    try {
      await expect(fallback(page)).toBeVisible({ timeout: 3000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

test.describe("Copy Share Link — clipboard unavailable", () => {
  test.beforeEach(async ({ page }) => {
    await blockClipboard(page);
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be blocked; assertions still hold */
      }
    });
  });

  test("shows an announced error and a selectable link field", async ({ page }) => {
    await open(page, "/portal");
    await clickCopy(page);

    const panel = fallback(page);

    // 2. Clear, screen-reader-announced explanation.
    await expect(panel).toHaveAttribute("role", "status");
    await expect(panel).toHaveAttribute("aria-live", "polite");
    await expect(panel).toContainText(/copying is blocked/i);
    await expect(panel).toContainText(/ctrl\/cmd \+ c/i);

    // 1. The button must not pretend the copy succeeded.
    await expect(copyButton(page)).toContainText(/copy share link/i);
    await expect(copyButton(page)).not.toContainText(/link copied/i);

    // 3. The exact canonical URL, in a focused + pre-selected read-only field.
    const field = page.locator("#manual-share-link");
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("readonly", "");
    const value = await field.inputValue();
    const url = new URL(value);
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.pathname).toBe("/");
    expect(url.hash).toBe("#order");

    await expect(field).toBeFocused();
    const selected = await field.evaluate(
      (el) => (el as HTMLInputElement).value.slice(
        (el as HTMLInputElement).selectionStart ?? 0,
        (el as HTMLInputElement).selectionEnd ?? 0,
      ),
    );
    expect(selected).toBe(value);

    // 4. prompt() was offered with the same URL.
    const prompts = await page.evaluate(() => (window as unknown as { __prompts: string[] }).__prompts);
    expect(prompts).toContain(value);

    // A toast repeats the link so it is visible outside the form too.
    await expect(page.getByText(/copy the link manually/i)).toBeVisible();
  });

  test("falls back with the preselected package still in the link", async ({ page }) => {
    await open(page, "/portal?package=full-hybrid#order");
    await clickCopy(page);

    // The link must carry the tier that is actually selected in the form.
    const slug = await page.locator(PACKAGE_SELECT).inputValue();
    expect(slug).toBeTruthy();

    const value = await page.locator("#manual-share-link").inputValue();
    const url = new URL(value);
    expect(url.searchParams.get("package")).toBeTruthy();
    expect(url.hash).toBe("#order");

    // Reopening the fallback link restores the same tier selection.
    await open(page, `${url.pathname}${url.search}${url.hash}`);
    await expect(page.locator(PACKAGE_SELECT)).toHaveValue(slug);
  });

  test("recovers silently once the clipboard works again", async ({ page }) => {
    await open(page, "/portal");
    await clickCopy(page);

    // Clipboard becomes available (e.g. permission granted on retry).
    await page.evaluate(() => {
      const store = { text: "" };
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (t: string) => {
            store.text = t;
          },
          readText: async () => store.text,
        },
        configurable: true,
      });
    });

    await copyButton(page).click();
    await expect(copyButton(page)).toContainText(/link copied/i);
    await expect(fallback(page)).toBeHidden();
  });
});
