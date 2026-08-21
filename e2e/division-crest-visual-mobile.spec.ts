import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Screenshot-based visual regression for the division crest badge on touch devices.
 * Captures the closed (idle) and open (focused/tooltip-visible) states so styling
 * drift — spacing, borders, type scale, focus ring, tooltip chrome — fails loudly.
 *
 * Runs on every touch project (mobile-chrome, mobile-safari). Baselines are stored
 * per project/platform by Playwright, so each engine gets its own reference image.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const crests = (page: Page) => page.getByTestId("division-crest");

async function openCatalog(page: Page) {
  await page.goto("/#catalog");
  await expect(page.getByRole("heading", { name: "The Catalog." })).toBeVisible();
  await expect(crests(page).first()).toBeVisible();
}

/** Stabilise the shot: no motion, no lazy images mid-flight, no caret blink. */
async function settle(page: Page, target: Locator) {
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`,
  });
  await target.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(250);
}

const shot = { maxDiffPixelRatio: 0.02, animations: "disabled" as const };

test.describe("Division crest — mobile visual regression", () => {
  test("crest renders its idle (closed) state consistently", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await settle(page, crest);

    // Nothing focused/hovered: inline label + artwork, tooltip suppressed at phone width.
    await expect(crest.getByTestId("division-tooltip")).toBeHidden();
    await expect(crest).toHaveScreenshot("crest-mobile-closed.png", shot);
  });

  test("crest renders its open (focused) state consistently", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await settle(page, crest);

    await crest.getByRole("img").focus();
    await expect(crest.getByRole("img")).toBeFocused();
    await page.waitForTimeout(150);

    await expect(crest).toHaveScreenshot("crest-mobile-open-focus.png", shot);
  });

  test("crest keeps a stable look after a tap", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await settle(page, crest);

    await crest.getByRole("img").tap();
    await page.waitForTimeout(150);

    await expect(crest).toHaveScreenshot("crest-mobile-tapped.png", shot);
  });

  test("second crest (different division) renders its own idle styling", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).nth(1);
    await settle(page, crest);

    await expect(crest).toHaveScreenshot("crest-mobile-closed-alt.png", shot);
  });
});

test.describe("Division crest — small-tablet visual regression (tooltip layer visible)", () => {
  // >= sm: the hover/focus tooltip layer renders, so both states are visually distinct.
  test.use({ viewport: { width: 768, height: 1024 } });

  test("tooltip closed state", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await settle(page, crest);

    await expect(crest.getByTestId("division-tooltip")).toHaveCSS("opacity", "0");
    await expect(crest).toHaveScreenshot("crest-tablet-tooltip-closed.png", shot);
  });

  test("tooltip open state via focus", async ({ page }) => {
    await openCatalog(page);
    const crest = crests(page).first();
    await settle(page, crest);

    await crest.getByRole("img").focus();
    await expect(crest.getByTestId("division-tooltip")).toHaveCSS("opacity", "1");
    await page.waitForTimeout(150);

    // Capture the crest plus the tooltip that overflows below it.
    const box = await crest.boundingBox();
    expect(box).not.toBeNull();
    await expect(page).toHaveScreenshot("crest-tablet-tooltip-open.png", {
      ...shot,
      clip: {
        x: Math.max(0, box!.x - 140),
        y: Math.max(0, box!.y - 8),
        width: Math.min(300, 768 - Math.max(0, box!.x - 140)),
        height: 110,
      },
    });
  });
});
