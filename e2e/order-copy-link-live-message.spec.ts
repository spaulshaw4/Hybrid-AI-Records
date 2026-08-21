import { expect, test, type Page } from "@playwright/test";

/**
 * The polite live region next to the copy button carries the *detail* of the
 * last copy attempt: on success the exact URL that landed on the clipboard, on
 * failure the clipboard-blocked guidance pointing at the manual-copy field.
 * These assertions pin both messages so a wording or wiring regression fails
 * loudly instead of silently degrading screen-reader feedback.
 */

const PACKAGE_SELECT = "#qo-package";
const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const copyStatus = (page: Page) => page.locator('[data-testid="share-link-copy-status"]');
const fallbackPanel = (page: Page) => page.locator('[data-testid="share-link-fallback"]');

/** Records async-clipboard writes and reports success, like a modern browser. */
async function stubWorkingClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __writes: string[] };
    w.__writes = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          w.__writes.push(text);
          return Promise.resolve();
        },
        readText: () => Promise.resolve(w.__writes[w.__writes.length - 1] ?? ""),
      },
    });
  });
}

/** Blocks every copy path: async clipboard rejects and execCommand refuses. */
async function stubBlockedClipboard(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __promptCalls: string[] };
    w.__promptCalls = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          Promise.reject(new DOMException("Write permission denied.", "NotAllowedError")),
        readText: () => Promise.reject(new DOMException("Blocked", "NotAllowedError")),
      },
    });
    // Legacy path refuses too, so the component must fall through to guidance.
    document.execCommand = (() => false) as typeof document.execCommand;
    window.prompt = ((message?: string) => {
      w.__promptCalls.push(String(message ?? ""));
      return null;
    }) as typeof window.prompt;
  });
}

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  await page.waitForTimeout(1500);
}

/** Clicks copy until the live region says something (first click can be swallowed). */
async function clickUntilAnnounced(page: Page) {
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyStatus(page)).not.toBeEmpty({ timeout: 4000 });
  }).toPass({ timeout: 20_000 });
}

test.describe("copy live region announces the outcome detail", () => {
  test("success: the announcement contains the exact URL that was copied", async ({ page }) => {
    test.slow();
    await stubWorkingClipboard(page);
    await open(page, "/?package=visual-push#order");

    await clickUntilAnnounced(page);
    await expect(copyButton(page)).toContainText(/link copied/i);

    const writes = await page.evaluate(
      () => (window as unknown as { __writes: string[] }).__writes,
    );
    expect(writes.length).toBeGreaterThan(0);
    const copied = writes[writes.length - 1];

    // The live region must name the very same URL handed to the clipboard.
    await expect(copyStatus(page)).toHaveText(`Copied this link: ${copied}`);

    // And that URL is the canonical order link for this package.
    const url = new URL(copied);
    expect(url.origin).toBe(new URL(page.url()).origin);
    expect(url.searchParams.get("package")).toBe("visual-push");
    expect(url.hash).toBe("#order");

    // Success must not surface the blocked-clipboard guidance or manual panel.
    await expect(copyStatus(page)).not.toContainText(/blocked clipboard access/i);
    await expect(fallbackPanel(page)).toHaveCount(0);
  });

  test("success: the announcement follows the URL after the package changes", async ({ page }) => {
    test.slow();
    await stubWorkingClipboard(page);
    await open(page, "/?package=visual-push#order");

    await clickUntilAnnounced(page);
    await expect(copyStatus(page)).toContainText("package=visual-push");

    await page.selectOption(PACKAGE_SELECT, "Full Label Release");
    await expect(async () => {
      await copyButton(page).click();
      await expect(copyStatus(page)).toContainText("package=full-label", { timeout: 4000 });
    }).toPass({ timeout: 20_000 });

    const writes = await page.evaluate(
      () => (window as unknown as { __writes: string[] }).__writes,
    );
    await expect(copyStatus(page)).toHaveText(`Copied this link: ${writes[writes.length - 1]}`);
  });

  test("failure: the announcement gives clipboard-blocked guidance", async ({ page }) => {
    test.slow();
    await stubBlockedClipboard(page);
    await open(page, "/?package=distribution-release#order");

    await clickUntilAnnounced(page);

    // Exact guidance wording, pointing at the manual field and the shortcut.
    await expect(copyStatus(page)).toHaveText(
      "Copying the share link failed. Your browser blocked clipboard access. Use the link field below the button and press Control or Command plus C to copy it.",
    );
    // No false success claim anywhere in the announcement or the button.
    await expect(copyStatus(page)).not.toContainText(/copied this link/i);
    await expect(copyButton(page)).not.toContainText(/link copied/i);

    // The guidance is actionable: the manual-copy field really is rendered.
    await expect(fallbackPanel(page)).toBeVisible();
    await expect(page.locator("#manual-share-link")).toBeVisible();
  });

  test("failure: the live region is polite and atomic so the whole message is read", async ({
    page,
  }) => {
    test.slow();
    await stubBlockedClipboard(page);
    await open(page, "/#order");

    await clickUntilAnnounced(page);

    const status = copyStatus(page);
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveAttribute("aria-live", "polite");
    await expect(status).toHaveAttribute("aria-atomic", "true");
    await expect(status).toContainText(/blocked clipboard access/i);
  });
});
