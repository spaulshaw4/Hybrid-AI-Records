import { expect, test, type Page } from "@playwright/test";

/**
 * The copied share link has to work as a real link: opening it in a fresh tab
 * must land on the order form with the same tier (and details) preselected —
 * both for the plain `/#order` shape and `/?package=<slug>#order`.
 */

const PACKAGE_SELECT = "#qo-package";

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
}

/** Clicks copy and returns the raw absolute URL from the clipboard. */
async function copyLink(page: Page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const btn = copyButton(page);
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    try {
      await expect(copyButton(page)).toContainText(/link copied/i, { timeout: 3000 });
      break;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  return page.evaluate(() => navigator.clipboard.readText());
}

/**
 * Opens the copied URL the way a recipient would: a brand-new tab in the same
 * browser context, navigated to the pasted link.
 */
async function openInNewTab(page: Page, url: string) {
  const tab = await page.context().newPage();
  await tab.goto(url, { waitUntil: "networkidle" });
  await expect(tab.locator(PACKAGE_SELECT)).toBeEnabled();
  return tab;
}

test.describe("Copied share link opens in a new tab", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(test.info().project.use.baseURL ?? "http://localhost:8080").origin,
    });
    // A saved draft would prefill the recipient's form independently of the link.
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be blocked; assertions still hold */
      }
    });
  });

  for (const tier of [
    { label: "Distribution & Release", slug: "distribution-release" },
    { label: "Production & Visual Push", slug: "visual-push" },
    { label: "Full Label Release", slug: "full-label" },
  ]) {
    test(`restores the ${tier.slug} tier from the copied link`, async ({ page }) => {
      await open(page, "/");
      await page.locator(PACKAGE_SELECT).selectOption(tier.label);

      const copied = await copyLink(page);
      const url = new URL(copied);
      expect(`${url.pathname}${url.search}${url.hash}`).toBe(`/?package=${tier.slug}#order`);

      const tab = await openInNewTab(page, copied);

      // The recipient lands on the order form with the shared tier selected.
      await expect(tab.locator(PACKAGE_SELECT)).toHaveValue(tier.label);
      expect(new URL(tab.url()).hash).toBe("#order");
      expect(new URL(tab.url()).searchParams.get("package")).toBe(tier.slug);

      // ...and the form is actually scrolled into view under the sticky header.
      const visible = await tab.locator(PACKAGE_SELECT).evaluate((el) => {
        const box = el.getBoundingClientRect();
        return box.top >= 0 && box.top < window.innerHeight;
      });
      expect(visible).toBe(true);

      await tab.close();
    });
  }

  test("plain /#order link opens on the form with the default tier", async ({ page }) => {
    // The bare hash shape is what the homepage entry points hand out.
    const base = test.info().project.use.baseURL ?? "http://localhost:8080";
    const tab = await openInNewTab(page, new URL("/#order", base).toString());

    await expect(tab.locator(PACKAGE_SELECT)).toHaveValue("Distribution & Release");
    expect(new URL(tab.url()).hash).toBe("#order");
    await expect(tab.locator("#qo-artist")).toBeVisible();

    await tab.close();
  });

  test("carries prefilled details along with the tier into the new tab", async ({ page }) => {
    await open(page, "/");
    await page.fill("#qo-artist", "Relay Artist");
    await page.fill("#qo-email", "relay@example.com");
    await page.locator(PACKAGE_SELECT).selectOption("Production & Visual Push");

    const tab = await openInNewTab(page, await copyLink(page));

    await expect(tab.locator(PACKAGE_SELECT)).toHaveValue("Production & Visual Push");
    await expect(tab.locator("#qo-artist")).toHaveValue("Relay Artist");
    await expect(tab.locator("#qo-email")).toHaveValue("relay@example.com");

    await tab.close();
  });

  test("alias links copied by a visitor open on the canonical tier", async ({ page }) => {
    await open(page, "/?package=full-hybrid#order");

    const copied = await copyLink(page);
    expect(new URL(copied).searchParams.get("package")).toBe("full-label");

    const tab = await openInNewTab(page, copied);
    await expect(tab.locator(PACKAGE_SELECT)).toHaveValue("Full Label Release");
    await tab.close();
  });
});
