import { test, expect, type Page, type Locator } from "@playwright/test";

/**
 * Currency switcher @ 375px — visual baseline + CTA-collision guard.
 *
 * At phone widths the switcher renders as a listbox that expands *in flow*, so
 * it must push page content down instead of floating over the primary CTAs
 * ("Start a Track" on the homepage, "Pay now" / "Apply" on /start). These tests
 * pin the closed and open appearance and assert geometric non-overlap for the
 * currencies whose longer labels stress the layout: NGN, EUR and ZAR.
 */

const WIDTH = 375;
const HEIGHT = 812;

/** Currencies that previously stressed the mobile layout. */
const CURRENCIES = ["EUR", "NGN", "ZAR"] as const;

const PAGES = [
  { name: "home", path: "/", cta: /start a track/i },
  { name: "start", path: "/start", cta: /(pay now|apply)/i },
] as const;

type Box = { x: number; y: number; width: number; height: number };

/** Freezes motion/fonts so snapshots and boxes are stable. */
async function stabilize(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`,
  });
  await page.evaluate(() => document.fonts.ready);
}

/** The in-flow mobile trigger for the currency listbox. */
function trigger(page: Page): Locator {
  return page.getByRole("button", { name: /display and pay in/i }).first();
}

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox();
  expect(b, "element should be laid out").not.toBeNull();
  return b!;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Boxes for every visible CTA matching `pattern`, in document order. */
async function ctaBoxes(page: Page, pattern: RegExp): Promise<{ label: string; box: Box }[]> {
  const ctas = page.getByRole("link", { name: pattern }).or(page.getByRole("button", { name: pattern }));
  const out: { label: string; box: Box }[] = [];
  for (const cta of await ctas.all()) {
    if (!(await cta.isVisible())) continue;
    const b = await cta.boundingBox();
    if (b && b.width > 0 && b.height > 0) out.push({ label: (await cta.innerText()).trim(), box: b });
  }
  expect(out.length, "page should expose at least one CTA").toBeGreaterThan(0);
  return out;
}

test.describe("currency switcher @ 375px", () => {
  test.use({ viewport: { width: WIDTH, height: HEIGHT } });

  for (const { name, path, cta } of PAGES) {
    test(`${name}: closed + open snapshots`, async ({ page }) => {
      await page.goto(path, { waitUntil: "networkidle" });
      await trigger(page).waitFor();
      await stabilize(page);
      await trigger(page).scrollIntoViewIfNeeded();

      await expect(trigger(page)).toHaveScreenshot(`currency-switcher-375-${name}-closed.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.01,
      });

      await trigger(page).click();
      const list = page.getByRole("listbox").first();
      await expect(list).toBeVisible();

      // Snapshot trigger + expanded list as one unit (their shared wrapper).
      const wrapper = page.locator("div", { has: page.getByRole("listbox") }).last();
      await expect(wrapper).toHaveScreenshot(`currency-switcher-375-${name}-open.png`, {
        animations: "disabled",
        maxDiffPixelRatio: 0.01,
      });

      // Sanity: the CTA set this page's overlap tests rely on actually exists.
      await ctaBoxes(page, cta);
    });

    for (const code of CURRENCIES) {
      test(`${name}: ${code} list stays contained and clear of CTAs`, async ({ page }) => {
        await page.goto(path, { waitUntil: "networkidle" });
        await trigger(page).waitFor();
        await stabilize(page);
        await trigger(page).scrollIntoViewIfNeeded();

        // Select the currency first, then reopen so the list renders in its
        // selected state (the widest label variant for that currency).
        await trigger(page).click();
        await page.getByRole("option", { name: new RegExp(code, "i") }).first().click();
        await expect(trigger(page)).toContainText(new RegExp(code, "i")); // CSS uppercases the label
        await trigger(page).click();

        const list = page.getByRole("listbox").first();
        await expect(list).toBeVisible();
        const listBox = await box(list);

        // Horizontally contained inside the 375px viewport.
        expect(listBox.x, `${code}: list must not clip off the start edge`).toBeGreaterThanOrEqual(0);
        expect(
          listBox.x + listBox.width,
          `${code}: list must not overflow the viewport`,
        ).toBeLessThanOrEqual(WIDTH + 0.5);

        // No CTA may sit underneath the expanded list.
        for (const { label, box: ctaBox } of await ctaBoxes(page, cta)) {
          expect(overlaps(listBox, ctaBox), `${code}: list overlaps CTA "${label}"`).toBe(false);
        }
      });
    }
  }
});
