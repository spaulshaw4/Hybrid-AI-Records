import { test, expect, type Page } from "@playwright/test";

/**
 * Mobile/touch behaviour for the division crest badge.
 * Runs on every touch-enabled project (mobile-chrome and mobile-safari/WebKit);
 * falls back to a phone-sized touch context when run under a desktop project.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const crests = (page: Page) => page.getByTestId("division-crest");

async function openCatalog(page: Page) {
  await page.goto("/#catalog");
  await expect(page.getByRole("heading", { name: "The Catalog." })).toBeVisible();
  await expect(crests(page).first()).toBeVisible();
}

/** Settle the layout, then tap the crest at its final resting position. */
async function tapFirstCrest(page: Page) {
  const crest = crests(page).first();
  await crest.scrollIntoViewIfNeeded();
  // Lazy artwork can still be reflowing the grid; wait for the box to hold still.
  let last = "";
  await expect
    .poll(
      async () => {
        const box = JSON.stringify(await crest.boundingBox());
        const stable = box === last;
        last = box;
        return stable;
      },
      { timeout: 5000, message: "crest position should settle before tapping" },
    )
    .toBe(true);
  await crest.tap();
  return crest;
}


test.describe("Division crest — mobile touch", () => {
  test("crest shows an inline division label instead of a hover tooltip", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();

    // The badge keeps an accessible name naming the division.
    const label = await crest.locator("[role='img']").getAttribute("aria-label");
    expect(label).toMatch(/Division|Records/i);

    // Small screens get the always-visible text label...
    await expect(crest.getByTestId("division-label-mobile")).toBeVisible();
    // ...while the hover-only tooltip stays hidden.
    await expect(crest.getByTestId("division-tooltip")).toBeHidden();
  });

  test("tapping the crest does not open the video modal or navigate", async ({ page }) => {
    await openCatalog(page);
    const urlBefore = page.url();
    await tapFirstCrest(page);

    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(page.url()).toBe(urlBefore);
  });

  test("tapping the crest does not trap focus", async ({ page }) => {
    await openCatalog(page);
    const crest = await tapFirstCrest(page);

    // Focus must be able to move away from the badge with the keyboard.
    await page.keyboard.press("Tab");
    const stillOnCrest = await crest.evaluate((el) => el.contains(document.activeElement));
    expect(stillOnCrest).toBe(false);

    // And tapping elsewhere must not restore focus into the badge.
    await page.getByRole("heading", { name: "The Catalog." }).tap();
    const refocused = await crest.evaluate((el) => el.contains(document.activeElement));
    expect(refocused).toBe(false);
  });

  test("crest interaction never blocks page scrolling", async ({ page }) => {
    await openCatalog(page);
    await tapFirstCrest(page);

    const overflow = await page.evaluate(() =>
      getComputedStyle(document.body).overflow + "|" + getComputedStyle(document.documentElement).overflow,
    );
    expect(overflow).not.toContain("hidden");

    const before = await page.evaluate(() => window.scrollY);
    // Touch contexts have no wheel; drive the scroll the way the page itself would.
    await page.evaluate(() => window.scrollBy(0, 800));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before);
  });

  test("crest badges stay inside the viewport (no horizontal overflow)", async ({ page }) => {
    await openCatalog(page);
    const width = page.viewportSize()!.width;
    const boxes = await crests(page).evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right };
      }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.left).toBeGreaterThanOrEqual(-1);
      expect(b.right).toBeLessThanOrEqual(width + 1);
    }
  });
});
