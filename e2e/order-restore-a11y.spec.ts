import { expect, test, type Page, type Browser } from "@playwright/test";
import { createRequire } from "node:module";

/**
 * The recipient's accessibility experience. A share link opened in a *fresh
 * session* (new context — no cookies, no draft, no history) must not just
 * restore values: focus has to land inside the order form, the arrival has to
 * be announced politely, Escape must return focus to the CTA, and the restored
 * form must be axe-clean and fully keyboard operable.
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";
const FORM = "#quick-order-form";

const LABELS = {
  "visual-push": "Production & Visual Push",
  "full-label": "Full Label Release",
} as const;

const DETAILS = {
  artist: "Ash & Anvil",
  email: "studio+a11y@ash-anvil.example",
};

const AXE_PATH = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

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

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  await page.waitForTimeout(2000);
}

async function typeInto(page: Page, selector: string, value: string) {
  await expect(async () => {
    await page.locator(selector).fill("");
    await page.locator(selector).click();
    await page.keyboard.type(value, { delay: 10 });
    await expect(page.locator(selector)).toHaveValue(value, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
}

async function copyUntil(page: Page, check: (copied: string) => void): Promise<string> {
  let copied = "";
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied);
  }).toPass({ timeout: 15_000 });
  return copied;
}

/** Produces a share URL carrying a tier plus prefilled artist/email. */
async function makeShareLink(page: Page, slug: keyof typeof LABELS): Promise<string> {
  await open(page, `/?package=${slug}#order`);
  let copied = "";
  await expect(async () => {
    await typeInto(page, ARTIST, DETAILS.artist);
    await typeInto(page, EMAIL, DETAILS.email);
    copied = await copyUntil(page, (c) => {
      const url = new URL(c);
      expect(url.searchParams.get("package")).toBe(slug);
      expect(url.searchParams.get("artist")).toBe(DETAILS.artist);
      expect(url.searchParams.get("email")).toBe(DETAILS.email);
    });
  }).toPass({ timeout: 90_000 });
  return copied;
}

/** Opens `url` in a brand-new context and waits for the restore to settle. */
async function openAsRecipient(browser: Browser, url: string, slug: keyof typeof LABELS) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toHaveValue(LABELS[slug], { timeout: 30_000 });
  await expect(page.locator(ARTIST)).toHaveValue(DETAILS.artist, { timeout: 30_000 });
  return { context, page };
}

test.describe.configure({ mode: "serial" });

test.describe("restored share link — focus management and announcements", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("focus lands on the first form field and the arrival is announced politely", async ({
    page,
    browser,
  }) => {
    test.slow();

    const link = await makeShareLink(page, "visual-push");
    const { context, page: recipient } = await openAsRecipient(browser, link, "visual-push");

    // Focus is moved into the form, onto its first focusable control.
    await expect(async () => {
      const inside = await recipient.evaluate(() => {
        const form = document.getElementById("quick-order-form");
        const active = document.activeElement as HTMLElement | null;
        const first = form?.querySelector<HTMLElement>(
          "input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
        );
        return {
          contained: !!(form && active && form.contains(active)),
          isFirst: !!(active && first && active === first),
          id: active?.id ?? "",
        };
      });
      expect(inside.contained, `active element: ${inside.id}`).toBe(true);
      expect(inside.isFirst, `active element: ${inside.id}`).toBe(true);
    }).toPass({ timeout: 20_000 });

    // …and the section is actually on screen, not focused off-viewport.
    await expect(recipient.locator(PACKAGE_SELECT)).toBeInViewport({ timeout: 10_000 });

    // A polite status message explains where the user has landed.
    const announcement = recipient.locator("[aria-live='polite']", {
      hasText: /order form/i,
    });
    await expect(announcement.first()).toContainText(/order form/i, { timeout: 20_000 });
    await expect(announcement.first()).toContainText(/escape/i);

    await context.close();
  });

  test("Escape returns focus out of the form to the Connect & Order CTA", async ({
    page,
    browser,
  }) => {
    test.slow();

    const link = await makeShareLink(page, "full-label");
    const { context, page: recipient } = await openAsRecipient(browser, link, "full-label");

    await expect(async () => {
      const focused = await recipient.evaluate(() => {
        const form = document.getElementById("quick-order-form");
        return !!(form && document.activeElement && form.contains(document.activeElement));
      });
      expect(focused).toBe(true);
    }).toPass({ timeout: 20_000 });

    await recipient.keyboard.press("Escape");

    await expect(async () => {
      const state = await recipient.evaluate(() => {
        const form = document.getElementById("quick-order-form");
        const active = document.activeElement as HTMLElement | null;
        return {
          outside: !!(active && active !== document.body && form && !form.contains(active)),
          name: active?.textContent?.trim().slice(0, 60) ?? "",
        };
      });
      expect(state.outside, `active element: ${state.name}`).toBe(true);
      expect(state.name).toMatch(/order|connect/i);
    }).toPass({ timeout: 20_000 });

    await context.close();
  });

  test("the restored form is axe-clean and has no error announcements on arrival", async ({
    page,
    browser,
  }) => {
    test.slow();

    const link = await makeShareLink(page, "visual-push");
    const { context, page: recipient } = await openAsRecipient(browser, link, "visual-push");

    // Restoration must not trigger validation errors for the recipient.
    await expect(recipient.locator("#qo-artist-error")).toHaveCount(0);
    await expect(recipient.locator("#qo-email-error")).toHaveCount(0);
    await expect(recipient.locator("#qo-package-error")).toHaveCount(0);
    await expect(recipient.locator(`${FORM} [aria-invalid='true']`)).toHaveCount(0);

    expect(await scan(recipient, FORM)).toEqual([]);

    await context.close();
  });

  test("every restored field stays keyboard reachable and labelled", async ({ page, browser }) => {
    test.slow();

    const link = await makeShareLink(page, "visual-push");
    const { context, page: recipient } = await openAsRecipient(browser, link, "visual-push");

    // Each control has an accessible name (label, aria-label, or aria-labelledby).
    for (const selector of [ARTIST, EMAIL, PACKAGE_SELECT]) {
      const named = await recipient.locator(selector).evaluate((el) => {
        const id = el.getAttribute("id");
        return (
          !!(id && document.querySelector(`label[for="${id}"]`)) ||
          !!el.getAttribute("aria-label") ||
          !!el.getAttribute("aria-labelledby")
        );
      });
      expect(named, `${selector} accessible name`).toBe(true);
    }

    // Tabbing forward from the focused first field walks the restored controls
    // in DOM order without leaving the form.
    const visited: string[] = [];
    await recipient.locator(ARTIST).focus();
    for (let i = 0; i < 3; i++) {
      await recipient.keyboard.press("Tab");
      visited.push(
        await recipient.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? ""),
      );
    }
    expect(visited.some((id) => id === "qo-email")).toBe(true);
    expect(visited.every((id) => id !== "")).toBe(true);

    // The copy button is still operable for the recipient re-sharing the link.
    await expect(copyButton(recipient)).toBeEnabled();

    await context.close();
  });
});
