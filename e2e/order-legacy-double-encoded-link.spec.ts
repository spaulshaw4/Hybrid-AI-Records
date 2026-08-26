import { expect, test, type Page } from "@playwright/test";

/**
 * Legacy share URLs (produced before the copy button settled on single
 * encoding) are double-encoded: a space arrives as `%2520`, an `@` as `%2540`,
 * and an alias slug can carry `%252D` for its hyphen. Pasting one of those into
 * the address bar must still restore the correct tier and the prefilled
 * artist/email values — not literal `%20` / `%40` text in the fields.
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

/** Double-encodes a value the way the legacy link builder did. */
function doubleEncode(value: string) {
  return encodeURIComponent(encodeURIComponent(value));
}

async function paste(page: Page, url: string) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  // Let URL-prefill and draft-restore effects settle.
  await page.waitForTimeout(2000);
}

async function expectRestored(page: Page, slug: Slug, artist: string, email: string) {
  await expect(page.locator(PACKAGE_SELECT)).toHaveValue(LABELS[slug], { timeout: 15_000 });
  await expect(page.locator(ARTIST)).toHaveValue(artist, { timeout: 15_000 });
  await expect(page.locator(EMAIL)).toHaveValue(email, { timeout: 15_000 });
  // No half-decoded escapes leaked into the visible fields.
  for (const field of [ARTIST, EMAIL]) {
    expect(await page.locator(field).inputValue()).not.toMatch(/%[0-9A-Fa-f]{2}/);
  }
}

test.describe("Legacy double-encoded share links", () => {
  for (const slug of Object.keys(LABELS) as Slug[]) {
    test(`restores tier and prefill for a double-encoded ${slug} link`, async ({ page }) => {
      const artist = "Cold Iron Choir & Sons";
      const email = "booking+legacy@cold-iron.example";
      const url =
        `/portal?package=${doubleEncode(slug)}` +
        `&artist=${doubleEncode(artist)}` +
        `&email=${doubleEncode(email)}#order`;

      await paste(page, url);
      await expectRestored(page, slug, artist, email);
      await expect(page.locator(ARTIST)).toBeInViewport();
    });
  }

  test("double-encoded alias slug normalizes to its canonical tier", async ({ page }) => {
    const artist = "Sol Vega";
    const email = "sol@vega.example";
    await paste(
      page,
      `/portal?package=${doubleEncode("the-visual-push")}&artist=${doubleEncode(artist)}&email=${doubleEncode(email)}#order`,
    );
    await expectRestored(page, "visual-push", artist, email);
    // The address bar is rewritten to the canonical slug.
    await expect(async () => {
      expect(new URL(page.url()).searchParams.get("package")).toBe("visual-push");
    }).toPass({ timeout: 15_000 });
  });

  test("double-encoded unicode and reserved characters survive the round trip", async ({ page }) => {
    const artist = "Ámbar & Ñoise #1";
    const email = "ámbar+tour@ñoise.example";
    await paste(
      page,
      `/portal?package=${doubleEncode("full-label")}&artist=${doubleEncode(artist)}&email=${doubleEncode(email)}#order`,
    );
    await expectRestored(page, "full-label", artist, email);
  });

  test("single-encoded links are unaffected by the legacy fallback", async ({ page }) => {
    const artist = "Modern Signal";
    const email = "hi@modern-signal.example";
    await paste(
      page,
      `/portal?package=visual-push&artist=${encodeURIComponent(artist)}&email=${encodeURIComponent(email)}#order`,
    );
    await expectRestored(page, "visual-push", artist, email);
  });
});
