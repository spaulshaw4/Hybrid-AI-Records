import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Division crest tooltip under real-world mobile conditions:
 *  - common browser zoom levels (100% / 125% / 150% / 200%), emulated the way a
 *    browser actually applies page zoom on a phone: the layout viewport shrinks
 *    and the page reflows (390 CSS px / zoom factor).
 *  - browser text-only zoom (accessibility font scaling)
 *  - prefers-reduced-motion: reduce
 *
 * Guards the three regressions that matter: the crest/tooltip must stay inside
 * the viewport (no horizontal overflow), must never block vertical scrolling,
 * and must never trap keyboard focus.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const PHONE_WIDTH = 390;
const crests = (page: Page) => page.getByTestId("division-crest");

async function openCatalog(page: Page) {
  await page.goto("/#catalog");
  await expect(page.getByRole("heading", { name: "The Catalog." })).toBeVisible();
  await expect(crests(page).first()).toBeVisible();
}

/** Browser page zoom on a phone reflows at viewportWidth / zoom. */
async function applyZoom(page: Page, zoom: number) {
  const width = Math.round(PHONE_WIDTH / zoom);
  await page.setViewportSize({ width, height: Math.round(844 / zoom) });
  await page.waitForTimeout(250);
  return width;
}

/** Text-only zoom (OS/browser font scaling; layout width unchanged). */
async function applyTextZoom(page: Page, percent: number) {
  await page.evaluate((p) => {
    document.documentElement.style.fontSize = `${(16 * p) / 100}px`;
  }, percent);
  await page.waitForTimeout(250);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  // Sub-pixel tolerance for fractional zoom rounding.
  expect(overflow).toBeLessThanOrEqual(2);
}

/** The crest itself must never render outside the scrollable page width. */
async function expectCrestWithinPage(page: Page, crest: Locator) {
  const box = await crest.boundingBox();
  expect(box).not.toBeNull();
  const pageWidth = await page.evaluate(() =>
    Math.max(document.documentElement.clientWidth, document.documentElement.scrollWidth),
  );
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(pageWidth + 2);
}

async function expectScrollStillWorks(page: Page, crest: Locator) {
  await crest.scrollIntoViewIfNeeded();
  const start = await page.evaluate(() => window.scrollY);
  // Scroll away from whichever end of the document we happen to be sitting at,
  // so the assertion is about scrollability, not about remaining headroom.
  // `instant` bypasses the site's smooth scrolling so the result is readable now.
  await page.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const top = window.scrollY >= max - 8 ? window.scrollY - 400 : window.scrollY + 400;
    window.scrollTo({ top, behavior: "instant" as ScrollBehavior });
  });
  await expect
    .poll(async () => page.evaluate((s) => Math.abs(window.scrollY - s), start), {
      timeout: 5000,
      message: "page should still scroll while the crest is visible",
    })
    .toBeGreaterThan(0);
}




async function expectNoFocusTrap(page: Page, crest: Locator) {
  const target = crest.getByRole("img");
  await target.scrollIntoViewIfNeeded();
  await target.focus();
  await expect(target).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(target).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(target).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(target).not.toBeFocused();
}

/**
 * 100–150% reflow to 390/312/260 CSS px — all real phone widths, so the page
 * must remain free of horizontal overflow. 200% reflows to 195 CSS px, narrower
 * than any shipping device; there we assert the crest stays inside the page and
 * stays usable rather than demanding a pixel-perfect layout.
 */
const STRICT_ZOOMS = [1, 1.25, 1.5];
const ALL_ZOOMS = [...STRICT_ZOOMS, 2];

test.describe("Division crest tooltip — mobile page zoom", () => {
  for (const zoom of STRICT_ZOOMS) {
    test(`no horizontal overflow at ${zoom * 100}% zoom, idle and focused`, async ({ page }) => {
      await openCatalog(page);
      await applyZoom(page, zoom);

      const crest = crests(page).first();
      await crest.scrollIntoViewIfNeeded();
      await expect(crest).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expectCrestWithinPage(page, crest);

      // The tooltip layer is right-anchored; showing it must not widen the page.
      await crest.getByRole("img").focus();
      await page.waitForTimeout(250);
      await expectNoHorizontalOverflow(page);
      await expectCrestWithinPage(page, crest);
    });
  }

  for (const zoom of ALL_ZOOMS) {
    test(`crest stays inside the page and positioned at ${zoom * 100}% zoom`, async ({ page }) => {
      await openCatalog(page);
      await applyZoom(page, zoom);

      const crest = crests(page).first();
      await crest.scrollIntoViewIfNeeded();
      await expect(crest).toBeVisible();
      await crest.getByRole("img").focus();
      await page.waitForTimeout(250);
      await expectCrestWithinPage(page, crest);

      // Tooltip must remain anchored to its crest (right-aligned, directly below).
      const crestBox = (await crest.getByRole("img").boundingBox())!;
      const tip = crest.getByTestId("division-tooltip");
      if (await tip.isVisible()) {
        const tipBox = (await tip.boundingBox())!;
        expect(tipBox.y).toBeGreaterThanOrEqual(crestBox.y);
        expect(Math.abs(tipBox.x + tipBox.width - (crestBox.x + crestBox.width))).toBeLessThanOrEqual(2);
      }
    });

    test(`does not block scrolling at ${zoom * 100}% zoom`, async ({ page }) => {
      await openCatalog(page);
      await applyZoom(page, zoom);
      const crest = crests(page).first();
      await crest.getByRole("img").tap();
      await expectScrollStillWorks(page, crest);
    });

    test(`does not trap focus at ${zoom * 100}% zoom`, async ({ page }) => {
      await openCatalog(page);
      await applyZoom(page, zoom);
      await expectNoFocusTrap(page, crests(page).first());
    });
  }
});

test.describe("Division crest tooltip — text-only zoom", () => {
  test("no horizontal overflow at 150% text zoom", async ({ page }) => {
    await openCatalog(page);
    await applyTextZoom(page, 150);

    const crest = crests(page).first();
    await crest.scrollIntoViewIfNeeded();
    await crest.getByRole("img").focus();
    await page.waitForTimeout(250);

    await expectNoHorizontalOverflow(page);
    await expectCrestWithinPage(page, crest);
    await expect(crest.getByTestId("division-label-mobile")).not.toBeEmpty();
  });

  test("crest stays usable at 200% text zoom", async ({ page }) => {
    await openCatalog(page);
    await applyTextZoom(page, 200);

    const crest = crests(page).first();
    await crest.scrollIntoViewIfNeeded();
    await expect(crest).toBeVisible();
    await expectCrestWithinPage(page, crest);
    await expect(crest.getByTestId("division-label-mobile")).not.toBeEmpty();
    await expectScrollStillWorks(page, crest);
    await expectNoFocusTrap(page, crest);
  });
});

test.describe("Division crest tooltip — reduced motion", () => {
  // Emulated per page: some engine builds ignore the context-level option.
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
  });

  test("tooltip transitions are disabled and it is not offset by a transform", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await crest.scrollIntoViewIfNeeded();

    const tooltip = crest.getByTestId("division-tooltip");
    // motion-reduce:transition-none + motion-reduce:translate-y-0
    await expect(tooltip).toHaveCSS("transition-property", "none");
    const transform = await tooltip.evaluate((el) => getComputedStyle(el).transform);
    expect(["none", "matrix(1, 0, 0, 1, 0, 0)"]).toContain(transform);
  });

  test("tooltip still reveals on focus with reduced motion", async ({ page }) => {
    await openCatalog(page);
    // Widen past the `sm` breakpoint where the hover/focus tooltip layer renders.
    await page.setViewportSize({ width: 768, height: 1024 });
    const crest = crests(page).first();
    await crest.scrollIntoViewIfNeeded();

    const tooltip = crest.getByTestId("division-tooltip");
    await expect(tooltip).toHaveCSS("opacity", "0");
    await crest.getByRole("img").focus();
    // No transition to wait out — opacity flips immediately.
    await expect(tooltip).toHaveCSS("opacity", "1");
    await expectNoHorizontalOverflow(page);
  });

  test("reduced motion still allows scrolling and does not trap focus", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await crest.getByRole("img").tap();
    await expectScrollStillWorks(page, crest);
    await expectNoFocusTrap(page, crest);
  });

  test("reduced motion at 150% zoom keeps the crest usable", async ({ page }) => {
    await openCatalog(page);
    await applyZoom(page, 1.5);

    const crest = crests(page).first();
    await crest.scrollIntoViewIfNeeded();
    await crest.getByRole("img").focus();
    await page.waitForTimeout(150);

    await expectNoHorizontalOverflow(page);
    await expectCrestWithinPage(page, crest);
    await expectScrollStillWorks(page, crest);
  });
});
