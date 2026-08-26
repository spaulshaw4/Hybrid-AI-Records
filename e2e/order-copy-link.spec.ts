import { expect, test, type Page } from "@playwright/test";

/**
 * "Copy Share Link" must always put the canonical order URL on the clipboard:
 *   - `/portal#order` — the plain shape used when no package is preselected
 *   - `/portal?package=<slug>#order` — with the canonical slug for the chosen tier,
 *     even when the visitor arrived on an alias like `?package=full-hybrid`
 */

const PACKAGE_SELECT = "#qo-package";

const copyButton = (page: Page) => page.getByRole("button", { name: /copy share link/i }).first();

/** Loads a page and waits for hydration so the copy handler is attached. */
async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: "networkidle" });
  await expect(page.locator(PACKAGE_SELECT)).toBeEnabled();
}

/** Clicks copy and returns the copied path + query + hash. */
async function copyLink(page: Page) {
  // Deep links scroll/animate the form into place, so a first click can land
  // while the button is still moving. Retry until the confirmed state shows.
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

  const raw = await page.evaluate(() => navigator.clipboard.readText());
  const url = new URL(raw);
  expect(url.origin).toBe(new URL(page.url()).origin);
  return `${url.pathname}${url.search}${url.hash}`;
}

test.describe("Copy Share Link", () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(test.info().project.use.baseURL ?? "http://localhost:8080").origin,
    });
    // A saved draft would prefill the form and change the copied URL.
    await page.addInitScript(() => {
      try {
        window.localStorage.clear();
      } catch {
        /* storage may be blocked; the assertions still hold */
      }
    });
  });

  test("copies the plain /#order link when no package is preselected", async ({ page }) => {
    await open(page, "/portal");

    // Entry points that carry no tier link to the bare canonical shape.
    const plainEntry = await page.evaluate(() => {
      const hrefs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="#order"]')).map(
        (a) => a.getAttribute("href") ?? "",
      );
      return hrefs.find((h) => !h.includes("package=")) ?? null;
    });
    expect(plainEntry).toBe("/portal#order");

    // Following the plain link keeps the hash route intact; once the form
    // hydrates it stamps the visitor's active tier, so the copied link is the
    // canonical `/portal?package=<slug>#order` for that tier.
    await open(page, "/portal#order");
    expect(new URL(page.url()).hash).toBe("#order");
    expect(await copyLink(page)).toBe("/portal?package=distribution-release#order");
  });

  test("copies /portal?package=<slug>#order for the selected package", async ({ page }) => {
    await open(page, "/portal");

    // Default tier.
    expect(await copyLink(page)).toBe("/portal?package=distribution-release#order");

    await page.locator(PACKAGE_SELECT).selectOption("Production & Visual Push");
    expect(await copyLink(page)).toBe("/portal?package=visual-push#order");

    await page.locator(PACKAGE_SELECT).selectOption("Full Label Release");
    expect(await copyLink(page)).toBe("/portal?package=full-label#order");

    await page.locator(PACKAGE_SELECT).selectOption("Distribution & Release");
    expect(await copyLink(page)).toBe("/portal?package=distribution-release#order");
  });

  test("copies the canonical slug when arriving on an alias link", async ({ page }) => {
    await open(page, "/portal?package=full-hybrid#order");
    await expect(page.locator(PACKAGE_SELECT)).toHaveValue("Full Label Release");
    expect(await copyLink(page)).toBe("/portal?package=full-label#order");
  });

  test("carries entered details in the copied link", async ({ page }) => {
    await open(page, "/portal");
    await page.fill("#qo-artist", "Test Artist");
    await page.fill("#qo-email", "artist@example.com");
    await page.locator(PACKAGE_SELECT).selectOption("Production & Visual Push");

    const copied = new URL(`http://x${await copyLink(page)}`);
    expect(copied.searchParams.get("package")).toBe("visual-push");
    expect(copied.searchParams.get("artist")).toBe("Test Artist");
    expect(copied.searchParams.get("email")).toBe("artist@example.com");
    expect(copied.hash).toBe("#order");
  });
});
