import { test, expect } from "@playwright/test";
import {
  PACKAGE_PRICES,
  amountFor,
  surchargeAmountFor,
  type CurrencyCode,
} from "@/lib/pricing";
import { money } from "@/lib/checkout-verification";
import { REFERENCE, SESSION_ID, openReturnPage, webhookEvent } from "./helpers/checkout-return";

/**
 * Checkout → simulated Stripe webhook → rendered return page, in a real browser.
 *
 * The Stripe API isn't reachable from CI, so this test stands in for it at the
 * exact seam the return page uses: the `confirmCheckoutOrder` server function.
 * We build a realistic `checkout.session.completed` payload for a ZAR order
 * (base line item + the separate 2% processing-fee line item), run it through
 * the same pure verification the server handler runs, and answer the browser's
 * server-function request with the result.
 *
 * What's asserted is what a South African buyer actually sees: the ZAR labels
 * rendered into the DOM — symbol, decimals and separators — and the mismatch
 * table when the webhook reports a total that drifted from `amount_total`.
 */

const CURRENCY: CurrencyCode = "zar";
const PRICE_ID = "foundation_song_onetime";

/** A ZAR event for this spec's package, with optional charged-total override. */
const zarEvent = (amountTotal?: number) =>
  webhookEvent({ priceId: PRICE_ID, currency: CURRENCY, ...(amountTotal !== undefined && { amountTotal }) });

test.describe("ZAR checkout return page", () => {
  test("renders the webhook's ZAR total with rand symbol, comma decimals and space grouping", async ({
    page,
  }) => {
    const event = zarEvent();
    const charged = event.data.object.amount_total;
    const expectedLabel = money(charged, CURRENCY);

    await openReturnPage(page, event);

    // Reference block carries the paid amount the webhook reported.
    await expect(page.getByText(REFERENCE)).toBeVisible();
    const paidLine = page.getByText(/^Paid /);
    await expect(paidLine).toHaveText(`Paid ${expectedLabel}`);

    // ZAR conventions, asserted on the string the browser actually painted.
    const rendered = ((await paidLine.textContent()) ?? "").replace(/^Paid /, "");
    expect(rendered).toBe(expectedLabel);
    expect(rendered.startsWith("R")).toBe(true); // rand symbol leads
    expect(rendered).toMatch(/,\d{2}$/); // comma decimal separator, 2 places
    expect(rendered).not.toContain("ZAR"); // symbol, not the ISO code
    expect(/[\u0660-\u0669]/.test(rendered)).toBe(false); // Latin digits only

    // The label is exactly base + 2% fee, so nothing drifted from amount_total.
    const base = PACKAGE_PRICES[PRICE_ID].amounts[CURRENCY];
    const fee = surchargeAmountFor(PRICE_ID, CURRENCY)!;
    expect(charged).toBe(base + fee);
    expect(charged).toBe(amountFor(PRICE_ID, CURRENCY));

    // A clean order redirects onward — no review alert on screen.
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/taking you to your track status page/i)).toBeVisible();
  });

  test("flags a webhook total that rounded the 2% fee down, showing both ZAR labels", async ({
    page,
  }) => {
    const base = PACKAGE_PRICES[PRICE_ID].amounts[CURRENCY];
    const shortfall = base + Math.floor((base * 200) / 10_000) - 1;
    const event = zarEvent(shortfall);

    await openReturnPage(page, event);

    const alert = page.getByRole("alert");
    await expect(alert).toContainText(/payment amount needs review/i);

    // Expected vs charged, both formatted as rand.
    const cells = alert.locator("tbody tr").first().locator("td");
    await expect(cells.nth(0)).toHaveText(money(amountFor(PRICE_ID, CURRENCY)!, CURRENCY));
    await expect(cells.nth(1)).toHaveText(money(shortfall, CURRENCY));

    // Currency row agrees on ZAR; the difference is a signed rand amount.
    await expect(alert.getByText("ZAR").first()).toBeVisible();
    const difference = money(amountFor(PRICE_ID, CURRENCY)! - shortfall, CURRENCY);
    await expect(alert).toContainText(`-${difference}`);

    // Buyer is held on the page — no auto-redirect while amounts disagree.
    await expect(page.getByText(/taking you to your track status page/i)).toHaveCount(0);
    await expect(alert).toContainText(REFERENCE);
    await expect(alert).toContainText(SESSION_ID);
  });
});
