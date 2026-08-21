import { expect, type Page, type Route } from "@playwright/test";
import { toJSONAsync } from "seroval";
import { PACKAGE_PRICES, surchargeAmountFor, type CurrencyCode } from "@/lib/pricing";
import { verifyCheckoutAmount } from "@/lib/checkout-verification";
import { classifyOutcome } from "@/lib/payment-outcome";

/**
 * Shared rig for return-page tests: builds a realistic Stripe
 * `checkout.session.completed` payload, reduces it exactly the way
 * `confirmCheckoutOrder` does, and answers the browser's server-function
 * request with the result — so the page renders real money labels without
 * touching the Stripe API.
 */

export const CONFIRM_FN = "confirmCheckoutOrder";
export const SESSION_ID = "cs_test_e2e_zar_1";
export const REFERENCE = "HAR-7Q4X";

export type EventOptions = {
  priceId: string;
  currency: CurrencyCode;
  amountTotal?: number;
};

/** A `checkout.session.completed` event shaped the way Stripe posts it. */
export function webhookEvent({ priceId, currency, amountTotal }: EventOptions) {
  const base = PACKAGE_PRICES[priceId].amounts[currency];
  const fee = surchargeAmountFor(priceId, currency) ?? 0;
  return {
    id: "evt_test_e2e_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        status: "complete",
        payment_status: "paid",
        currency,
        amount_total: amountTotal ?? base + fee,
        payment_intent: "pi_test_e2e_1",
        customer_details: { email: "artist@example.com" },
        metadata: { priceId, currency, trackReference: REFERENCE },
        line_items: {
          data: [
            { description: PACKAGE_PRICES[priceId].name, amount: base },
            { description: "International processing fee (2%)", amount: fee },
          ],
        },
      },
    },
  };
}

/** The same reduction `confirmCheckoutOrder` performs on a Stripe session. */
export function confirmResultFor(event: ReturnType<typeof webhookEvent>) {
  const session = event.data.object;
  const outcome = classifyOutcome({
    status: session.status,
    paymentStatus: session.payment_status,
  });
  const verdict = verifyCheckoutAmount({
    metaPriceId: session.metadata.priceId,
    metaCurrency: session.metadata.currency,
    chargedCurrency: session.currency,
    amountTotal: session.amount_total,
    reference: session.metadata.trackReference,
    referenceFound: true,
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
  });
  return {
    ok: true as const,
    paid: outcome === "paid",
    outcome,
    outcomeMessage: null,
    alreadyConfirmed: false,
    duplicateOfSessionId: null,
    reference: session.metadata.trackReference,
    amountLabel: verdict.chargedLabel,
    email: session.customer_details.email,
    mismatch: verdict.mismatch,
  };
}

/** Answers the browser's `confirmCheckoutOrder` call with the webhook result. */
export async function installConfirmRoute(page: Page, result: unknown) {
  await page.route("**/_serverFn/**", async (route: Route) => {
    const id = route.request().url().split("/_serverFn/")[1] ?? "";
    let decoded = "";
    try {
      decoded = Buffer.from(decodeURIComponent(id), "base64").toString("utf8");
    } catch {
      /* not a server-fn id we care about */
    }
    if (!decoded.includes(CONFIRM_FN)) return route.fallback();
    const json = (await toJSONAsync({ result, context: {} })) as { t: unknown };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "x-tss-serialized": "true" },
      body: JSON.stringify(json.t),
    });
  });
}

/** Opens the return page with the webhook's outcome already mocked in. */
export async function openReturnPage(page: Page, event: ReturnType<typeof webhookEvent>) {
  await installConfirmRoute(page, confirmResultFor(event));
  await page.goto(`/checkout/return?session_id=${SESSION_ID}`);
  await expect(page.getByRole("heading", { name: /order confirmed/i })).toBeVisible();
}
