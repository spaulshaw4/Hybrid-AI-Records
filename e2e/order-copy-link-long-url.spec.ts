import { expect, test, type Page } from "@playwright/test";

/**
 * Long share URLs (a 200-char artist name plus a ~600-char demo link) are the
 * worst case for the manual-copy fallback: the read-only field has to hold the
 * whole canonical URL, pre-select every character of it (not just the visible
 * slice), hand the same full string to prompt(), and keep the status message
 * accurate. This also checks the happy path copies the identical long URL.
 */

const PACKAGE_SELECT = "#qo-package";
const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();
const fallback = (page: Page) => page.getByTestId("share-link-fallback");
const manualField = (page: Page) => page.locator("#manual-share-link");

/** 200 chars, with reserved/unicode characters that must survive encoding. */
const LONG_ARTIST = ("Ärtîst & Co. / Studio #7 — Продакшн ").repeat(6).slice(0, 200).trim();
/** A ~600 char https link (no whitespace, so it passes link validation). */
const LONG_LINK = `https://cdn.example.com/stems/${"a1b2c3d4e5".repeat(40)}?take=final&mix=v12&notes=${"x".repeat(90)}`.slice(
  0,
  600,
);
const LONG_EMAIL = `${"artist.longbox.name".repeat(3)}@studio-with-a-very-long-domain-name.example.com`;

async function blockClipboard(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = () => false;
    (window as unknown as { __prompts: string[] }).__prompts = [];
    window.prompt = (message?: string, value?: string) => {
      (window as unknown as { __prompts: string[] }).__prompts.push(String(value ?? message ?? ""));
      return null;
    };
  });
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  // Draft restoration can land seconds after load and wipe the form, so give
  // it room before typing (fillLongValues re-checks stability afterwards).
  await page.waitForTimeout(4000);
}

/** Fills the long values and returns exactly what the inputs ended up holding. */
async function fillLongValues(page: Page) {
  await expect(async () => {
    await page.locator("#qo-artist").fill(LONG_ARTIST);
    await page.locator("#qo-email").fill(LONG_EMAIL);
    await page.locator(PACKAGE_SELECT).selectOption({ label: "Production & Visual Push" });
    await page.locator("#qo-link").fill(LONG_LINK);
    // Long enough that a late draft restore would have already clobbered us.
    await page.waitForTimeout(3000);
    await expect(page.locator("#qo-artist")).toHaveValue(LONG_ARTIST, { timeout: 1500 });
    await expect(page.locator("#qo-link")).toHaveValue(LONG_LINK, { timeout: 1500 });
    await expect(page.locator(PACKAGE_SELECT)).toHaveValue("Production & Visual Push", {
      timeout: 1500,
    });
  }).toPass({ timeout: 45_000 });

  return {
    artist: await page.locator("#qo-artist").inputValue(),
    email: await page.locator("#qo-email").inputValue(),
    link: await page.locator("#qo-link").inputValue(),
  };
}

/** The canonical URL we expect for those values. */
function expectedUrl(origin: string, v: { artist: string; email: string; link: string }) {
  const params = new URLSearchParams();
  params.set("package", "visual-push");
  if (v.artist) params.set("artist", v.artist);
  if (v.email) params.set("email", v.email);
  if (v.link) params.set("demo", v.link);
  return `${origin}/?${params.toString()}#order`;
}

/** Clicks copy; the deep-link scroll can shift the button under a first click. */
async function clickCopy(page: Page, until: () => Promise<void>) {
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await until();
  }).toPass({ timeout: 25_000 });
}

test.describe("Copy Share Link — very long URLs", () => {
  test("blocked clipboard: fallback holds, selects, and prompts the full canonical URL", async ({
    page,
  }) => {
    test.slow();
    await blockClipboard(page);
    await open(page, "/#order");

    const values = await fillLongValues(page);
    const origin = await page.evaluate(() => window.location.origin);
    const expected = expectedUrl(origin, values);
    // Sanity: this really is an unusually long URL.
    expect(expected.length).toBeGreaterThan(900);

    await clickCopy(page, async () => {
      await expect(fallback(page)).toBeVisible({ timeout: 3000 });
    });

    // 1. The field carries the entire URL — no truncation, no ellipsis.
    const fieldValue = await manualField(page).inputValue();
    expect(fieldValue).toBe(expected);
    expect(fieldValue.length).toBe(expected.length);

    // 2. Every character is selected, not just the visible slice.
    const selection = await manualField(page).evaluate((el) => {
      const input = el as HTMLInputElement;
      return {
        start: input.selectionStart,
        end: input.selectionEnd,
        length: input.value.length,
        focused: document.activeElement === input,
        selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
      };
    });
    expect(selection.start).toBe(0);
    expect(selection.end).toBe(selection.length);
    expect(selection.selected).toBe(expected);
    expect(selection.focused).toBe(true);

    // 3. The status message stays accurate for the blocked state.
    await expect(fallback(page)).toContainText(/copying is blocked in this browser/i);
    await expect(fallback(page)).toHaveAttribute("aria-live", "polite");
    await expect(copyButton(page)).toContainText(/copy share link/i);
    await expect(copyButton(page)).not.toContainText(/link copied/i);

    // 4. prompt() received the same full URL.
    const prompts = await page.evaluate(
      () => (window as unknown as { __prompts: string[] }).__prompts,
    );
    expect(prompts.at(-1)).toBe(expected);

    // 5. The URL round-trips: reopening it restores the long values.
    const restored = new URL(fieldValue);
    expect(restored.searchParams.get("artist")).toBe(values.artist);
    expect(restored.searchParams.get("demo")).toBe(values.link);
    expect(restored.hash).toBe("#order");
  });

  test("working clipboard: the same long URL is copied in full", async ({ page, context }) => {
    test.slow();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await open(page, "/#order");

    const values = await fillLongValues(page);
    const origin = await page.evaluate(() => window.location.origin);
    const expected = expectedUrl(origin, values);

    await clickCopy(page, async () => {
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 3000 });
    });

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(expected);
    expect(copied.length).toBe(expected.length);

    // Success state, and no fallback field for a clipboard that worked.
    await expect(fallback(page)).toHaveCount(0);
    await expect(copyButton(page).locator("span[aria-live='polite']")).toHaveText(
      "Share link copied to clipboard",
    );
  });

  test("long values restore from the copied link in a fresh context", async ({ browser, page }) => {
    test.slow();
    await blockClipboard(page);
    await open(page, "/#order");
    const values = await fillLongValues(page);

    await clickCopy(page, async () => {
      await expect(fallback(page)).toBeVisible({ timeout: 3000 });
    });
    const shared = await manualField(page).inputValue();

    const fresh = await browser.newContext();
    const other = await fresh.newPage();
    await other.goto(shared, { waitUntil: "domcontentloaded" });
    await expect(other.locator(PACKAGE_SELECT)).toBeEnabled();
    await expect(other.locator("#qo-artist")).toHaveValue(values.artist, { timeout: 15_000 });
    await expect(other.locator("#qo-link")).toHaveValue(values.link, { timeout: 15_000 });
    await expect(other.locator(PACKAGE_SELECT)).toHaveValue("Production & Visual Push");
    await fresh.close();
  });
});
