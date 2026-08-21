import { expect, test, type Page } from "@playwright/test";

/**
 * A share link is usually opened by *someone else* — a browser with no cookies,
 * no localStorage draft, and no prior visit. This suite copies a link in one
 * context, then opens it in a brand-new context (fresh storage state) and
 * confirms the order form restores the tier and the prefilled details purely
 * from the URL, with no leakage from the copying session's saved draft.
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";

const LABELS = {
  "distribution-release": "Distribution & Release",
  "visual-push": "Production & Visual Push",
  "full-label": "Full Label Release",
} as const;

type Slug = keyof typeof LABELS;

const ARTIST_NAME = "Cold Iron Choir";
const EMAIL_ADDR = "booking+share@cold-iron.example";

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle before typing.
  await page.waitForTimeout(2000);
}

/** Selects a tier and waits until the app reacted (address bar carries it). */
async function chooseTier(page: Page, slug: Slug) {
  await expect(async () => {
    await page.selectOption(PACKAGE_SELECT, LABELS[slug]);
    expect(new URL(page.url()).searchParams.get("package")).toBe(slug);
  }).toPass({ timeout: 20_000 });
}

/** Types a value, retried as a unit so late restore effects can't wipe it. */
async function typeInto(page: Page, selector: string, value: string) {
  await expect(async () => {
    await page.locator(selector).fill("");
    await page.locator(selector).click();
    await page.keyboard.type(value, { delay: 15 });
    await expect(page.locator(selector)).toHaveValue(value, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
}

/** Clicks copy until the clipboard satisfies `check` (first click can be swallowed). */
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

/** Asserts the given page has zero carried-over app storage. */
async function assertFreshStorage(page: Page) {
  const state = await page.evaluate(() => ({
    cookies: document.cookie,
    local: window.localStorage.length,
    session: window.sessionStorage.length,
  }));
  expect(state.cookies).toBe("");
  expect(state.local).toBe(0);
  expect(state.session).toBe(0);
}

test.describe("share link opened in a fresh browser context", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const slug of ["distribution-release", "visual-push", "full-label"] as Slug[]) {
    test(`restores tier and details with cleared cookies — ${slug}`, async ({ page, browser }) => {
      test.slow();

      // 1. Author the link in the current session.
      await open(page, "/#order");
      await chooseTier(page, slug);
      // Refill inside the copy retry: under parallel load a late draft-restore
      // can wipe fields after they were typed, so the fill+copy must be one unit.
      let copied = "";
      await expect(async () => {
        await typeInto(page, ARTIST, ARTIST_NAME);
        await typeInto(page, EMAIL, EMAIL_ADDR);
        copied = await copyUntil(page, (c) => {
          const url = new URL(c);
          expect(url.searchParams.get("package")).toBe(slug);
          expect(url.searchParams.get("artist")).toBe(ARTIST_NAME);
          expect(url.searchParams.get("email")).toBe(EMAIL_ADDR);
        });
      }).toPass({ timeout: 90_000 });

      // 2. Open it in a brand-new context: no cookies, no localStorage draft.
      const fresh = await browser.newContext();
      const recipient = await fresh.newPage();
      await recipient.goto(copied, { waitUntil: "domcontentloaded" });
      await assertFreshStorage(recipient);

      // 3. Everything the recipient sees comes from the URL alone.
      await expect(recipient.locator(PACKAGE_SELECT)).toBeEnabled();
      await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS[slug], { timeout: 30_000 });
      await expect(recipient.locator(ARTIST)).toHaveValue(ARTIST_NAME, { timeout: 30_000 });
      await expect(recipient.locator(EMAIL)).toHaveValue(EMAIL_ADDR, { timeout: 30_000 });

      // The form is the landing target, not somewhere further down the page.
      await expect(recipient.locator(PACKAGE_SELECT)).toBeInViewport({ timeout: 10_000 });
      expect(new URL(recipient.url()).hash).toBe("#order");

      await fresh.close();
    });
  }

  test("a bare /#order link in a fresh context opens an empty form at the default tier", async ({
    page,
    browser,
  }) => {
    test.slow();

    // Author a session with details, but copy a link from a page without them:
    // the recipient must not inherit the sender's draft.
    await open(page, "/#order");
    await typeInto(page, ARTIST, ARTIST_NAME);

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    await recipient.goto("/#order", { waitUntil: "domcontentloaded" });
    await assertFreshStorage(recipient);

    await expect(recipient.locator(PACKAGE_SELECT)).toBeEnabled();
    await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS["distribution-release"]);
    await expect(recipient.locator(ARTIST)).toHaveValue("");
    await expect(recipient.locator(EMAIL)).toHaveValue("");

    await fresh.close();
  });

  test("an alias link normalizes to its canonical tier in a fresh context", async ({ browser }) => {
    test.slow();

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    await recipient.goto("/?package=full-hybrid#order", { waitUntil: "domcontentloaded" });
    await assertFreshStorage(recipient);

    await expect(recipient.locator(PACKAGE_SELECT)).toBeEnabled();
    await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS["full-label"], { timeout: 30_000 });

    await fresh.close();
  });
});
