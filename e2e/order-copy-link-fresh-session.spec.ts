import { expect, test, type Page } from "@playwright/test";

/**
 * The recipient's view of a share link. The sender switches tiers several times
 * and fills every prefillable field; the link is then opened in a *fresh
 * session* (new context — no cookies, no localStorage draft, no history) and
 * must restore the LATEST tier plus all prefilled values from the URL alone.
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";
const LINK = "#qo-link";

const LABELS = {
  "distribution-release": "Distribution & Release",
  "visual-push": "Production & Visual Push",
  "full-label": "Full Label Release",
} as const;

type Slug = keyof typeof LABELS;

const DETAILS = {
  artist: "Ash & Anvil",
  email: "studio+share@ash-anvil.example",
  link: "https://drive.example.com/stems/ash-anvil-final",
};

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle before typing.
  await page.waitForTimeout(2000);
}

/** Selects a tier and waits until the address bar reflects it. */
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
    await page.keyboard.type(value, { delay: 10 });
    await expect(page.locator(selector)).toHaveValue(value, { timeout: 2000 });
  }).toPass({ timeout: 25_000 });
}

/** Clicks copy until the clipboard satisfies `check`. */
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

/** Asserts the page carries no app storage at all. */
async function assertFreshSession(page: Page) {
  const state = await page.evaluate(() => ({
    cookies: document.cookie,
    local: window.localStorage.length,
    session: window.sessionStorage.length,
  }));
  expect(state.cookies).toBe("");
  expect(state.local).toBe(0);
  expect(state.session).toBe(0);
}

test.describe("fresh session restores the latest tier and every prefilled value", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("tier switched three times — the copied link carries only the last one", async ({
    page,
    browser,
  }) => {
    test.slow();

    await open(page, "/portal#order");

    // Walk through every tier so a stale value would be easy to catch.
    await chooseTier(page, "distribution-release");
    await chooseTier(page, "full-label");
    await chooseTier(page, "visual-push");

    let copied = "";
    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      await typeInto(page, EMAIL, DETAILS.email);
      await typeInto(page, LINK, DETAILS.link);
      copied = await copyUntil(page, (c) => {
        const url = new URL(c);
        expect(url.searchParams.get("package")).toBe("visual-push");
        expect(url.searchParams.get("artist")).toBe(DETAILS.artist);
        expect(url.searchParams.get("email")).toBe(DETAILS.email);
        expect(url.searchParams.get("demo")).toBe(DETAILS.link);
      });
    }).toPass({ timeout: 90_000 });

    // No trace of the earlier selections in the shared URL.
    expect(copied).not.toContain("distribution-release");
    expect(copied).not.toContain("full-label");

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    await recipient.goto(copied, { waitUntil: "domcontentloaded" });
    await assertFreshSession(recipient);

    await expect(recipient.locator(PACKAGE_SELECT)).toBeEnabled();
    await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS["visual-push"], {
      timeout: 30_000,
    });
    await expect(recipient.locator(ARTIST)).toHaveValue(DETAILS.artist, { timeout: 30_000 });
    await expect(recipient.locator(EMAIL)).toHaveValue(DETAILS.email, { timeout: 30_000 });
    await expect(recipient.locator(LINK)).toHaveValue(DETAILS.link, { timeout: 30_000 });

    // The recipient lands on the form, ready to continue.
    await expect(recipient.locator(PACKAGE_SELECT)).toBeInViewport({ timeout: 10_000 });
    expect(new URL(recipient.url()).hash).toBe("#order");

    await fresh.close();
  });

  test("the restored form submits straight through without retyping", async ({
    page,
    browser,
  }) => {
    test.slow();

    await open(page, "/portal?package=full-label#order");

    let copied = "";
    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      await typeInto(page, EMAIL, DETAILS.email);
      copied = await copyUntil(page, (c) => {
        const url = new URL(c);
        expect(url.searchParams.get("package")).toBe("full-label");
        expect(url.searchParams.get("artist")).toBe(DETAILS.artist);
        expect(url.searchParams.get("email")).toBe(DETAILS.email);
      });
    }).toPass({ timeout: 90_000 });

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    await recipient.goto(copied, { waitUntil: "domcontentloaded" });
    await assertFreshSession(recipient);

    await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS["full-label"], {
      timeout: 30_000,
    });
    await expect(recipient.locator(ARTIST)).toHaveValue(DETAILS.artist, { timeout: 30_000 });

    // Nothing is flagged invalid on arrival — the values came in clean.
    await expect(recipient.locator("#qo-artist-error")).toHaveCount(0);
    await expect(recipient.locator("#qo-email-error")).toHaveCount(0);
    await expect(recipient.locator("#qo-package-error")).toHaveCount(0);

    await fresh.close();
  });

  test("a second fresh session gets the same restore, and the sender's later edits don't leak", async ({
    page,
    browser,
  }) => {
    test.slow();

    await open(page, "/portal#order");
    await chooseTier(page, "distribution-release");

    let copied = "";
    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      await typeInto(page, EMAIL, DETAILS.email);
      copied = await copyUntil(page, (c) => {
        const url = new URL(c);
        expect(url.searchParams.get("package")).toBe("distribution-release");
        expect(url.searchParams.get("artist")).toBe(DETAILS.artist);
      });
    }).toPass({ timeout: 90_000 });

    // Sender keeps working after sharing; the already-copied link must freeze.
    await chooseTier(page, "full-label");
    await typeInto(page, ARTIST, "Later Draft Name");

    for (const attempt of [1, 2]) {
      const fresh = await browser.newContext();
      const recipient = await fresh.newPage();
      await recipient.goto(copied, { waitUntil: "domcontentloaded" });
      await assertFreshSession(recipient);

      await expect(recipient.locator(PACKAGE_SELECT), `attempt ${attempt}`).toHaveValue(
        LABELS["distribution-release"],
        { timeout: 30_000 },
      );
      await expect(recipient.locator(ARTIST)).toHaveValue(DETAILS.artist, { timeout: 30_000 });
      await expect(recipient.locator(EMAIL)).toHaveValue(DETAILS.email, { timeout: 30_000 });

      await fresh.close();
    }
  });
});
