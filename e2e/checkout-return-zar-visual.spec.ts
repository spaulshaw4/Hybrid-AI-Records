import { test, expect, type Page } from "@playwright/test";
import { PACKAGE_PRICES, amountFor, type CurrencyCode } from "@/lib/pricing";
import { openReturnPage, webhookEvent } from "./helpers/checkout-return";

/**
 * Visual regression for the ZAR money labels on the checkout return page.
 *
 * The rand label is the one string on this page a buyer checks character by
 * character: "R" prefix, non-breaking space grouping, comma decimals. Those are
 * produced by Intl but *presented* by our CSS — font stack, tabular figures,
 * letter-spacing, alignment in the mismatch table. A typography or layout
 * change can wreck symbol placement or clip decimals without breaking any
 * assertion-based test, so these snapshots pin the painted result.
 *
 * Element-scoped screenshots (not full page) keep the baselines stable against
 * unrelated copy changes elsewhere on the page.
 */

const CURRENCY: CurrencyCode = "zar";
/** Small, mid and large totals: one, four and six significant rand digits. */
const CASES = [
  { name: "foundation", priceId: "foundation_song_onetime" },
  { name: "visual-push", priceId: "visual_push_song_onetime" },
  { name: "full-hybrid", priceId: "full_hybrid_song_onetime" },
] as const;

const WIDTHS = [
  { name: "375", width: 375 },
  { name: "1280", width: 1280 },
] as const;

/** Freezes anything that could make a money-label snapshot flake. */
async function stabilize(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addStyleTag({
    content: `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`,
  });
  await page.evaluate(() => document.fonts.ready);
}

test.describe("return page ZAR money label visuals", () => {
  for (const { name, priceId } of CASES) {
    for (const { name: widthName, width } of WIDTHS) {
      test(`paid label — ${name} @ ${widthName}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openReturnPage(page, webhookEvent({ priceId, currency: CURRENCY }));
        await stabilize(page);

        const paidLine = page.getByText(/^Paid /);
        await expect(paidLine).toBeVisible();
        // Sanity-check the baseline captures the real charged total.
        await expect(paidLine).toContainText("R");

        await expect(paidLine).toHaveScreenshot(
          `return-zar-paid-${name}-${widthName}.png`,
          { animations: "disabled", maxDiffPixelRatio: 0.01 },
        );
      });
    }
  }

  for (const { name: widthName, width } of WIDTHS) {
    test(`mismatch table money column @ ${widthName}px`, async ({ page }) => {
      const priceId = "visual_push_song_onetime";
      const base = PACKAGE_PRICES[priceId].amounts[CURRENCY];
      // A total that truncated the 2% fee instead of rounding it up.
      const shortfall = base + Math.floor((base * 200) / 10_000) - 1;
      expect(shortfall).toBeLessThan(amountFor(priceId, CURRENCY)!);

      await page.setViewportSize({ width, height: 1100 });
      await openReturnPage(page, webhookEvent({ priceId, currency: CURRENCY, amountTotal: shortfall }));
      await stabilize(page);

      const table = page.getByRole("alert").locator("table");
      await expect(table).toBeVisible();

      // Expected vs charged rand, side by side — right alignment, mono figures
      // and the crimson emphasis on the charged column all get pinned here.
      await expect(table).toHaveScreenshot(
        `return-zar-mismatch-table-${widthName}.png`,
        { animations: "disabled", maxDiffPixelRatio: 0.01 },
      );
    });
  }
});
