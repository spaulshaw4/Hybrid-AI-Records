import { expect, test, type Page } from "@playwright/test";

/**
 * Campaign attribution must survive sharing: when a visitor arrives from a UTM
 * tagged link, the copied share URL keeps every utm_* param intact while the
 * tier + prefill restoration behaves exactly as it does without them.
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

const UTM = {
  utm_source: "instagram",
  utm_medium: "social",
  utm_campaign: "summer_drop 2026",
  utm_content: "story-swipe-up",
  utm_term: "hybrid ai records",
};

const utmQuery = new URLSearchParams(UTM).toString();

const DETAILS = {
  artist: "Ash & Anvil",
  email: "studio+utm@ash-anvil.example",
};

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle before typing.
  await page.waitForTimeout(2000);
}

async function chooseTier(page: Page, slug: Slug) {
  await expect(async () => {
    await page.selectOption(PACKAGE_SELECT, LABELS[slug]);
    expect(new URL(page.url()).searchParams.get("package")).toBe(slug);
  }).toPass({ timeout: 20_000 });
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

function expectUtm(copied: string) {
  const params = new URL(copied).searchParams;
  for (const [key, value] of Object.entries(UTM)) {
    expect(params.get(key), `${key} preserved`).toBe(value);
  }
}

test.describe("share link preserves UTM parameters", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copying from a UTM-tagged visit keeps every utm_* param and the tier", async ({ page }) => {
    test.slow();

    await open(page, `/?${utmQuery}#order`);
    await chooseTier(page, "visual-push");

    let copied = "";
    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      await typeInto(page, EMAIL, DETAILS.email);
      copied = await copyUntil(page, (c) => {
        const url = new URL(c);
        expect(url.searchParams.get("package")).toBe("visual-push");
        expect(url.searchParams.get("artist")).toBe(DETAILS.artist);
        expect(url.searchParams.get("email")).toBe(DETAILS.email);
        expectUtm(c);
      });
    }).toPass({ timeout: 90_000 });

    // Spaces stay percent-encoded, never raw, and the hash target is unchanged.
    expect(copied).not.toContain("summer_drop 2026");
    expect(new URL(copied).hash).toBe("#order");
  });

  test("the recipient of a UTM link restores the same tier and prefill", async ({
    page,
    browser,
  }) => {
    test.slow();

    await open(page, `/portal?package=full-label&${utmQuery}#order`);

    let copied = "";
    await expect(async () => {
      await typeInto(page, ARTIST, DETAILS.artist);
      copied = await copyUntil(page, (c) => {
        expect(new URL(c).searchParams.get("package")).toBe("full-label");
        expect(new URL(c).searchParams.get("artist")).toBe(DETAILS.artist);
        expectUtm(c);
      });
    }).toPass({ timeout: 90_000 });

    const fresh = await browser.newContext();
    const recipient = await fresh.newPage();
    await recipient.goto(copied, { waitUntil: "domcontentloaded" });

    await expect(recipient.locator(PACKAGE_SELECT)).toHaveValue(LABELS["full-label"], {
      timeout: 30_000,
    });
    await expect(recipient.locator(ARTIST)).toHaveValue(DETAILS.artist, { timeout: 30_000 });

    // The attribution survives the round trip in the recipient's address bar too.
    const landed = new URL(recipient.url()).searchParams;
    for (const [key, value] of Object.entries(UTM)) {
      expect(landed.get(key), `${key} on landing`).toBe(value);
    }
    expect(new URL(recipient.url()).hash).toBe("#order");

    await fresh.close();
  });

  test("a visit with no UTM params copies a clean link (no empty utm keys)", async ({ page }) => {
    test.slow();

    await open(page, "/portal#order");
    await chooseTier(page, "distribution-release");

    const copied = await copyUntil(page, (c) => {
      expect(new URL(c).searchParams.get("package")).toBe("distribution-release");
    });

    expect(copied).not.toContain("utm_");
  });
});
