import { expect, test, type Page } from "@playwright/test";

/**
 * Re-sharing after an edit. A link arrives prefilled, the recipient corrects
 * the artist name / email, then copies the link again: the *new* URL must carry
 * the edited values (single-encoded, no stale originals) and reopen with them
 * restored.
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

const ORIGINAL = { artist: "Cold Iron Choir", email: "booking@cold-iron.example" };

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

function prefilledLink(slug: Slug, artist: string, email: string) {
  return (
    `/?package=${slug}` +
    `&artist=${encodeURIComponent(artist)}` +
    `&email=${encodeURIComponent(email)}#order`
  );
}

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle before editing.
  await page.waitForTimeout(2000);
}

/**
 * Waits for the URL prefill to land. Under parallel load an empty local draft
 * can restore *after* the URL prefill and blank the fields, so this reloads and
 * re-checks instead of failing on that race.
 */
async function expectPrefilled(page: Page, artist: string, email: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await expect(page.locator(ARTIST)).toHaveValue(artist, { timeout: 20_000 });
      await expect(page.locator(EMAIL)).toHaveValue(email, { timeout: 10_000 });
      return;
    } catch {
      // Reload once and give hydration room before trying again.
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
      await page.waitForTimeout(2000);
    }
  }
  await expect(page.locator(ARTIST)).toHaveValue(artist, { timeout: 20_000 });
  await expect(page.locator(EMAIL)).toHaveValue(email, { timeout: 10_000 });
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
  }).toPass({ timeout: 20_000 });
  return copied;
}

/** Edits both fields and copies, retried together against late restores. */
async function editAndCopy(page: Page, slug: Slug, artist: string, email: string) {
  let copied = "";
  await expect(async () => {
    await typeInto(page, ARTIST, artist);
    await typeInto(page, EMAIL, email);
    copied = await copyUntil(page, (c) => {
      const url = new URL(c);
      expect(url.searchParams.get("package")).toBe(slug);
      expect(url.searchParams.get("artist")).toBe(artist);
      expect(url.searchParams.get("email")).toBe(email);
    });
  }).toPass({ timeout: 90_000 });
  return copied;
}

async function expectRestores(page: Page, url: string, slug: Slug, artist: string, email: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(page.locator(PACKAGE_SELECT)).toHaveValue(LABELS[slug], { timeout: 30_000 });
  await expect(page.locator(ARTIST)).toHaveValue(artist, { timeout: 30_000 });
  await expect(page.locator(EMAIL)).toHaveValue(email, { timeout: 30_000 });
}

test.describe("editing prefilled details and re-copying the share link", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  for (const slug of Object.keys(LABELS) as Slug[]) {
    test(`re-copied link carries the edited values — ${slug}`, async ({ page, browser }) => {
      test.slow();

      await open(page, prefilledLink(slug, ORIGINAL.artist, ORIGINAL.email));
      await expectPrefilled(page, ORIGINAL.artist, ORIGINAL.email);

      const artist = `Molten ${LABELS[slug].split(" ")[0]} Ensemble`;
      const email = "new.contact+re-share@molten.example";
      const copied = await editAndCopy(page, slug, artist, email);

      // The old values are gone from the link entirely, not just overwritten.
      expect(copied).not.toContain(encodeURIComponent(ORIGINAL.artist));
      expect(copied).not.toContain(encodeURIComponent(ORIGINAL.email));
      // Single-encoded reserved characters, exactly one trailing #order.
      const raw = copied.slice(copied.indexOf("?") + 1, copied.indexOf("#"));
      expect(raw).toContain("email=new.contact%2Bre-share%40molten.example");
      expect(raw).not.toMatch(/%25/);
      expect(copied.match(/#order/g)).toHaveLength(1);

      // A recipient with no shared storage sees the edited values.
      const fresh = await browser.newContext();
      const recipient = await fresh.newPage();
      await expectRestores(recipient, copied, slug, artist, email);
      await fresh.close();
    });
  }

  test("editing again produces a newer link; the previous one keeps its own values", async ({
    page,
    browser,
  }) => {
    test.slow();

    await open(page, prefilledLink("visual-push", ORIGINAL.artist, ORIGINAL.email));

    const first = { artist: "First Pass Choir", email: "first@pass.example" };
    const firstUrl = await editAndCopy(page, "visual-push", first.artist, first.email);

    const second = { artist: "Séconde & Passe #2", email: "second+edit@passe.example" };
    const secondUrl = await editAndCopy(page, "visual-push", second.artist, second.email);

    expect(secondUrl).not.toBe(firstUrl);
    expect(secondUrl).not.toContain(encodeURIComponent(first.artist));

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    // The newest link restores the newest values...
    await expectRestores(recipient, secondUrl, "visual-push", second.artist, second.email);
    // ...and the earlier link is still a valid snapshot of what it captured.
    await expectRestores(recipient, firstUrl, "visual-push", first.artist, first.email);
    await fresh.close();
  });

  test("clearing an edited field drops it from the re-copied link", async ({ page }) => {
    test.slow();

    await open(page, prefilledLink("full-label", ORIGINAL.artist, ORIGINAL.email));

    const artist = "Only Artist Remains";
    const copied = await (async () => {
      let out = "";
      await expect(async () => {
        await typeInto(page, ARTIST, artist);
        await page.locator(EMAIL).fill("");
        await expect(page.locator(EMAIL)).toHaveValue("");
        out = await copyUntil(page, (c) => {
          const url = new URL(c);
          expect(url.searchParams.get("artist")).toBe(artist);
          expect(url.searchParams.has("email")).toBe(false);
        });
      }).toPass({ timeout: 90_000 });
      return out;
    })();

    expect(new URL(copied).searchParams.get("package")).toBe("full-label");
  });
});
