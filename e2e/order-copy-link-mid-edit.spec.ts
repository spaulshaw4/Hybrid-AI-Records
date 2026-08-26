import { expect, test, type Page } from "@playwright/test";

/**
 * Copying while the form is still being edited must capture the *latest* state:
 * the tier just selected and the characters just typed. The risk is a stale
 * race — the URL sync runs on change/push, so a copy fired immediately after a
 * tier switch (or before a debounce flushes) could serialize the previous tier
 * or an empty field.
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

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, entry: string) {
  await page.goto(entry, { waitUntil: "domcontentloaded" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
  await expect(copyButton(page)).toBeVisible();
  // Let URL-prefill / draft-restore effects settle so they don't clear typing.
  await page.waitForTimeout(2000);
}

/** Copy, retrying the click as a unit until the clipboard satisfies `check`. */
async function copyUntil(page: Page, check: (copied: string) => void): Promise<string> {
  let copied = "";
  await expect(async () => {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 4000 });
    copied = await page.evaluate(() => navigator.clipboard.readText());
    check(copied);
  }).toPass({ timeout: 40_000 });
  return copied;
}

const slugOf = (copied: string) => new URL(copied).searchParams.get("package");

/**
 * Selects a tier and confirms the app actually reacted (the address bar carries
 * the new slug). Under parallel load the select can be interacted with before
 * React attaches its handler, which would silently leave the old tier bound to
 * the copy button — exactly the stale race we're testing for, but caused by the
 * harness rather than the app.
 */
async function chooseTier(page: Page, slug: Slug) {
  await expect(async () => {
    await page.selectOption(PACKAGE_SELECT, LABELS[slug]);
    expect(new URL(page.url()).searchParams.get("package")).toBe(slug);
  }).toPass({ timeout: 20_000 });
}

test.describe("copy share link mid-edit", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copy immediately after switching tier uses the new tier, not the previous one", async ({ page }) => {
    test.slow();
    await open(page, "/portal?package=distribution-release#order");

    // Switch tier and copy right away — no settle time, no blur.
    await chooseTier(page, "full-label");
    const copied = await copyUntil(page, (c) => {
      expect(slugOf(c)).toBe("full-label");
    });
    expect(slugOf(copied)).toBe("full-label");
    expect(copied).not.toContain("distribution-release");
    expect(copied.endsWith("#order")).toBe(true);
  });

  test("rapid tier switches settle on the last selection", async ({ page }) => {
    test.slow();
    await open(page, "/portal?package=distribution-release#order");

    const order: Slug[] = ["visual-push", "full-label", "visual-push", "distribution-release", "full-label"];
    for (const slug of order) await chooseTier(page, slug);

    const copied = await copyUntil(page, (c) => expect(slugOf(c)).toBe("full-label"));
    // The UI and the link agree on the final tier.
    await expect(page.locator(PACKAGE_SELECT)).toHaveValue(LABELS["full-label"]);
    expect(slugOf(copied)).toBe("full-label");
  });

  test("copy mid-typing carries the characters entered so far", async ({ page }) => {
    test.slow();
    await open(page, "/portal#order");

    // Type without blurring: the field is still focused when we copy. Retried
    // as a unit because a late restore effect can clear a field typed too early.
    const typeInto = async (selector: string, expected: string) => {
      await expect(async () => {
        // Reset then retype the whole value: retries must not accumulate text,
        // and a late restore effect can wipe a field typed too early.
        await page.locator(selector).fill("");
        await page.locator(selector).click();
        await page.keyboard.type(expected, { delay: 20 });
        await expect(page.locator(selector)).toHaveValue(expected, { timeout: 2000 });
      }).toPass({ timeout: 25_000 });
    };

    await typeInto(ARTIST, "Ash Vector");
    await typeInto(EMAIL, "ash@vector.example");
    await chooseTier(page, "visual-push");

    const copied = await copyUntil(page, (c) => {
      const url = new URL(c);
      expect(url.searchParams.get("package")).toBe("visual-push");
      expect(url.searchParams.get("artist")).toBe("Ash Vector");
      expect(url.searchParams.get("email")).toBe("ash@vector.example");
    });

    // Editing further then re-copying reflects the newer value, never the stale one.
    await typeInto(ARTIST, "Ash Vector Live");

    const second = await copyUntil(page, (c) => {
      expect(new URL(c).searchParams.get("artist")).toBe("Ash Vector Live");
    });
    expect(second).not.toBe(copied);
  });

  test("tier changed after a first copy produces an updated link", async ({ page }) => {
    test.slow();
    await open(page, "/portal?package=visual-push#order");

    const first = await copyUntil(page, (c) => expect(slugOf(c)).toBe("visual-push"));

    await chooseTier(page, "distribution-release");
    const second = await copyUntil(page, (c) => expect(slugOf(c)).toBe("distribution-release"));

    expect(slugOf(first)).toBe("visual-push");
    expect(slugOf(second)).toBe("distribution-release");
  });
});
