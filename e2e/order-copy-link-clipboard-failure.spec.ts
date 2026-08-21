import { expect, test, type Page } from "@playwright/test";

/**
 * When `navigator.clipboard` fails (denied permission, insecure context, or an
 * outright missing API), the button must silently fall back to the hidden
 * textarea + `document.execCommand("copy")` path and still report success —
 * "Link Copied", the polite live-region announcement, a success toast, and no
 * manual-copy panel.
 */

const PACKAGE_SELECT = "#qo-package";
const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const fallbackPanel = (page: Page) => page.locator('[data-testid="share-link-fallback"]');

/**
 * Breaks the async clipboard and records every `execCommand("copy")` against a
 * live textarea, reporting success like a legacy browser would.
 *
 * @param mode "reject" = writeText throws; "missing" = no clipboard object.
 */
async function stubClipboard(page: Page, mode: "reject" | "missing") {
  await page.addInitScript((m) => {
    const w = window as unknown as {
      __execCopies: string[];
      __promptCalls: string[];
      __writeTextCalls: number;
    };
    w.__execCopies = [];
    w.__promptCalls = [];
    w.__writeTextCalls = 0;

    if (m === "missing") {
      Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    } else {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => {
            w.__writeTextCalls += 1;
            return Promise.reject(new DOMException("Write permission denied.", "NotAllowedError"));
          },
          readText: () => Promise.reject(new DOMException("Blocked", "NotAllowedError")),
        },
      });
    }

    // Legacy path: succeed, capturing whatever the selected textarea holds.
    document.execCommand = ((command: string) => {
      if (command !== "copy") return false;
      const active = document.activeElement as HTMLTextAreaElement | null;
      const value =
        active && active.tagName === "TEXTAREA"
          ? active.value
          : (document.getSelection()?.toString() ?? "");
      w.__execCopies.push(value);
      return true;
    }) as typeof document.execCommand;

    // prompt() must never be reached on a successful legacy copy.
    window.prompt = ((message?: string) => {
      w.__promptCalls.push(String(message ?? ""));
      return null;
    }) as typeof window.prompt;
  }, mode);
}

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  await page.waitForTimeout(1500);
}

/** Clicks copy until the button reports success (first click can be swallowed). */
async function clickUntilCopied(page: Page) {
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(btn).toContainText(/link copied/i, { timeout: 4000 });
  }).toPass({ timeout: 20_000 });
}

const execCopies = (page: Page) =>
  page.evaluate(() => (window as unknown as { __execCopies: string[] }).__execCopies);
const promptCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __promptCalls: string[] }).__promptCalls);

test.describe("clipboard failure falls back to the textarea copy", () => {
  for (const mode of ["reject", "missing"] as const) {
    test(`navigator.clipboard ${mode}: textarea copy still confirms success`, async ({ page }) => {
      test.slow();
      await stubClipboard(page, mode);
      await open(page, "/?package=visual-push#order");

      await clickUntilCopied(page);

      // 1. The legacy textarea path actually carried the canonical share URL.
      const copies = await execCopies(page);
      expect(copies.length).toBeGreaterThan(0);
      const copied = copies[copies.length - 1];
      const url = new URL(copied);
      expect(url.origin).toBe(new URL(page.url()).origin);
      expect(url.searchParams.get("package")).toBe("visual-push");
      expect(url.hash).toBe("#order");

      // 2. Success is reported exactly as in the happy path.
      await expect(copyButton(page)).toContainText(/link copied/i);
      await expect(page.getByText("Share link copied", { exact: false }).first()).toBeVisible({
        timeout: 5000,
      });
      await expect(copyButton(page).locator("span[aria-live='polite']")).toHaveText(
        /share link copied to clipboard/i,
      );

      // 3. No degraded UI: the manual panel and prompt() stay out of the way.
      await expect(fallbackPanel(page)).toHaveCount(0);
      expect(await promptCalls(page)).toEqual([]);

      // 4. The confirmation reverts to the idle label afterwards.
      await expect(copyButton(page)).toContainText(/copy share link/i, { timeout: 10_000 });
    });
  }

  test("rejected clipboard was genuinely attempted before the textarea fallback", async ({
    page,
  }) => {
    test.slow();
    await stubClipboard(page, "reject");
    await open(page, "/#order");

    await clickUntilCopied(page);

    const attempts = await page.evaluate(
      () => (window as unknown as { __writeTextCalls: number }).__writeTextCalls,
    );
    expect(attempts).toBeGreaterThan(0);
    const copies = await execCopies(page);
    expect(copies[copies.length - 1]).toMatch(/#order$/);
  });

  test("the fallback copy leaves no stray textarea behind and restores selection", async ({
    page,
  }) => {
    test.slow();
    await stubClipboard(page, "reject");
    await open(page, "/?package=full-label#order");

    await clickUntilCopied(page);

    // The helper element is created and removed inside the same click.
    expect(await page.locator("body > textarea").count()).toBe(0);
    // Focus is not stranded on a removed node.
    const active = await page.evaluate(() => document.activeElement?.tagName ?? "");
    expect(active).not.toBe("TEXTAREA");

    const copies = await execCopies(page);
    expect(new URL(copies[copies.length - 1]).searchParams.get("package")).toBe("full-label");
  });
});
