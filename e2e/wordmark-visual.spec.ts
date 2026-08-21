import { test, expect, type Page } from "@playwright/test";

/**
 * Visual regression for the brand lockup in the nav and the footer.
 *
 * The lockup steps down as one unit below `sm`, so these snapshots pin the
 * mark size, gap, baseline alignment and lettering at the widths where the
 * step happens — in both themes. Any future cropping, wrapping or spacing
 * regression in the header or footer wordmark fails here.
 */

const HEADER_LINK = 'header a[aria-label="Hybrid AI Records — back to top"]';
const FOOTER_LINK = 'footer a[aria-label="Hybrid AI Records — back to top"]';

const WIDTHS = [
  { name: "320", width: 320 },
  { name: "375", width: 375 },
  { name: "768", width: 768 },
  { name: "1280", width: 1280 },
] as const;

const THEMES = ["dark", "light"] as const;

async function setTheme(page: Page, theme: (typeof THEMES)[number]) {
  // The app scopes its light surface with `.theme-light`; dark is the :root default.
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("theme-light", t === "light");
  }, theme);
}

/** Freezes anything that could make a lockup snapshot flake. */
async function stabilize(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`,
  });
  await page.evaluate(() => document.fonts.ready);
  // The mark is a raster; wait for the DPR-matched variant to decode.
  await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("header img, footer img"));
    await Promise.all(imgs.map((i) => (i.complete ? i.decode().catch(() => {}) : Promise.resolve())));
  });
}

test.describe("wordmark visual regression", () => {
  for (const theme of THEMES) {
    for (const { name, width } of WIDTHS) {
      test(`nav lockup @ ${name}px / ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await page.locator(HEADER_LINK).waitFor();
        await setTheme(page, theme);
        await stabilize(page);

        await expect(page.locator(HEADER_LINK).first()).toHaveScreenshot(
          `nav-wordmark-${name}-${theme}.png`,
          { animations: "disabled", maxDiffPixelRatio: 0.01 },
        );
      });

      test(`footer lockup @ ${name}px / ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/", { waitUntil: "domcontentloaded" });
        const footer = page.locator(FOOTER_LINK).first();
        await footer.scrollIntoViewIfNeeded();
        await setTheme(page, theme);
        await stabilize(page);
        // Land the lockup on a whole-pixel offset: a fractional scroll position
        // resamples the text antialiasing and makes the snapshot flake.
        await page.evaluate(async () => {
          const el = document.querySelector<HTMLElement>('footer a[aria-label="Hybrid AI Records — back to top"]')!;
          const y = Math.round(window.scrollY + el.getBoundingClientRect().top - 200);
          window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        });


        await expect(footer).toHaveScreenshot(`footer-wordmark-${name}-${theme}.png`, {
          animations: "disabled",
          maxDiffPixelRatio: 0.01,
        });
      });
    }
  }

  test("nav lockup keeps its full row without overlapping the menu button @ 320px", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(HEADER_LINK).waitFor();
    await stabilize(page);

    // Geometry guard: catches clipping that a full-row snapshot could hide.
    const lockup = await page.locator(HEADER_LINK).first().boundingBox();
    const menu = await page.locator('header button[aria-label="Toggle menu"]').boundingBox();
    expect(lockup && menu).toBeTruthy();
    expect(lockup!.x + lockup!.width).toBeLessThanOrEqual(menu!.x + 1);
    // Single-line lockup: never taller than the mark + a hair of leading.
    expect(lockup!.height).toBeLessThan(44);

    await expect(page.locator("header").first()).toHaveScreenshot("nav-row-320-dark.png", {
      animations: "disabled",
      maxDiffPixelRatio: 0.01,
    });
  });

  test("nav and footer lockups render at identical proportions", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(HEADER_LINK).waitFor();
    await stabilize(page);

    const read = async (selector: string) =>
      page.locator(`${selector} img`).first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const gap = getComputedStyle(el.parentElement!).columnGap;
        const text = el.parentElement!.querySelector("span.font-display");
        return { w: r.width, h: r.height, gap, fontSize: text ? getComputedStyle(text).fontSize : null };
      });

    const nav = await read(HEADER_LINK);
    const footer = await read(FOOTER_LINK);
    expect(nav).toEqual(footer);
    expect(nav.w).toBe(nav.h); // square mark, never cropped or stretched
  });
});
