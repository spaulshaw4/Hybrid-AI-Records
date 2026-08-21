import { expect, test, type Page } from "@playwright/test";

/**
 * The share link is assembled from user-typed values, so every reserved or
 * non-ASCII character must be percent-encoded in the raw copied string while
 * still decoding back to exactly what was typed. A missed encoding would
 * truncate the link at `#`, swallow fields at `&`, or corrupt `+` in emails.
 *
 * Verified for canonical and alias tiers (aliases must be rewritten to their
 * canonical slug before encoding).
 */

const PACKAGE_SELECT = "#qo-package";
const ARTIST = "#qo-artist";
const EMAIL = "#qo-email";

/** Nasty-but-plausible inputs: reserved chars, unicode, and a plus-address. */
const TRICKY_ARTIST = "Ñoise & Fire / 100% Live #1 + Co";
const TRICKY_EMAIL = "band+demo tag@récords-lt.example";

/** Entry slug -> canonical slug expected in the copied URL. */
const TIERS: Array<{ name: string; entry: string; slug: string }> = [
  { name: "canonical: distribution-release", entry: "distribution-release", slug: "distribution-release" },
  { name: "canonical: visual-push", entry: "visual-push", slug: "visual-push" },
  { name: "canonical: full-label", entry: "full-label", slug: "full-label" },
  { name: "alias: foundation", entry: "foundation", slug: "distribution-release" },
  { name: "alias: the-visual-push", entry: "the-visual-push", slug: "visual-push" },
  { name: "alias: full-hybrid", entry: "full-hybrid", slug: "full-label" },
];

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(`/?package=${entry}#order`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  // The copy button only renders/interacts after hydration.
  await expect(copyButton(page)).toBeVisible();
  // Let the URL-prefill/draft-restore effects settle before typing, otherwise
  // they clear fields that were filled too early.
  await page.waitForTimeout(2000);
}

/**
 * Fills the prefill fields and copies the link, retrying as a unit: under load
 * the app's URL-prefill/draft-restore effects can land after we type (clearing
 * the field) or swallow the first click, so we retry until the clipboard
 * actually carries the typed values.
 */
async function fillAndCopy(page: Page): Promise<string> {
  let copied = "";
  await expect(async () => {
    await page.fill(ARTIST, TRICKY_ARTIST);
    await page.fill(EMAIL, TRICKY_EMAIL);
    await expect(page.locator(ARTIST)).toHaveValue(TRICKY_ARTIST, { timeout: 2000 });
    await expect(page.locator(EMAIL)).toHaveValue(TRICKY_EMAIL, { timeout: 2000 });

    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });

    copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("artist=");
    expect(copied).toContain("email=");
  }).toPass({ timeout: 45_000 });
  return copied;
}

test.describe("Copy Share Link — percent-encoding", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(process.env.E2E_BASE_URL ?? "http://localhost:8080").origin,
    });
  });

  for (const { name, entry, slug } of TIERS) {
    test(`encodes slug and prefill fields — ${name}`, async ({ page }) => {
      await open(page, entry);

      const copied = await fillAndCopy(page);
      const url = new URL(copied);

      // Slug is canonical and needs no escaping (kebab-case ASCII only).
      expect(url.searchParams.get("package")).toBe(slug);
      expect(copied).toContain(`package=${slug}`);
      expect(slug).toMatch(/^[a-z0-9-]+$/);

      // Raw string: reserved and non-ASCII characters are escaped, so the
      // query never breaks apart and the hash stays at the very end.
      const rawQuery = copied.slice(copied.indexOf("?") + 1, copied.indexOf("#"));
      expect(rawQuery).not.toMatch(/[ "<>{}|\\^`]/);
      expect(rawQuery).not.toMatch(/[^\x20-\x7e]/); // no literal unicode
      expect(rawQuery).toContain("%26"); // & from the artist name
      expect(rawQuery).toContain("%23"); // # from "#1"
      expect(rawQuery).toContain("%2B"); // + from "+ Co" / plus-addressing
      expect(rawQuery).toContain("%40"); // @ in the email

      // A literal `#` must appear exactly once — the trailing #order hash.
      expect(copied.split("#").length - 1).toBe(1);
      expect(url.hash).toBe("#order");

      // Round-trip: decoded values match exactly what was typed.
      expect(url.searchParams.get("artist")).toBe(TRICKY_ARTIST);
      expect(url.searchParams.get("email")).toBe(TRICKY_EMAIL);

      // And the toast echoes the same encoded string that was copied.
      await expect(
        page.locator("[data-sonner-toast]").filter({ hasText: /share link copied/i }),
      ).toContainText(copied);
    });
  }

  test("encoded link reopens with the exact original values restored", async ({ page, context }) => {
    test.slow();
    await open(page, "full-hybrid");
    const copied = await fillAndCopy(page);

    const next = await context.newPage();
    await next.goto(copied, { waitUntil: "domcontentloaded" });
    await expect(next.locator(PACKAGE_SELECT)).toBeEnabled();

    // Prefill lands once hydration + restore effects finish; allow for a slow
    // dev server under parallel load.
    await expect(next.locator(ARTIST)).toHaveValue(TRICKY_ARTIST, { timeout: 30_000 });
    await expect(next.locator(EMAIL)).toHaveValue(TRICKY_EMAIL, { timeout: 30_000 });
    await expect(next.locator(PACKAGE_SELECT)).toHaveValue(/full label release/i, { timeout: 30_000 });
    await next.close();
  });
});
