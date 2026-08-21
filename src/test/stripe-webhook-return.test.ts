/**
 * Simulated Stripe webhook → return page consistency.
 *
 * Builds realistic `checkout.session.completed` event payloads (base line item
 * plus the separate processing-fee line item we push for non-USD orders), runs
 * them through the same pure pipeline the return page uses
 * (classifyOutcome → decideConfirmAction → verifyCheckoutAmount) and asserts
 * that the totals, the 2% processing fee, and the submission reference all
 * agree with the payment intent's recorded `amount_total`.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  PACKAGE_PRICES,
  amountFor,
  surchargeAmountFor,
  type CurrencyCode,
} from "@/lib/pricing";
import { money, verifyCheckoutAmount } from "@/lib/checkout-verification";
import { classifyOutcome, decideConfirmAction } from "@/lib/payment-outcome";

const PRICE_IDS = Object.keys(PACKAGE_PRICES);

type WebhookOverrides = {
  amountTotal?: number;
  chargedCurrency?: CurrencyCode;
  paymentStatus?: string;
  status?: string;
  reference?: string | null;
};

/** Mimic the `checkout.session.completed` payload Stripe posts to the webhook. */
function webhookEvent(priceId: string, currency: CurrencyCode, overrides: WebhookOverrides = {}) {
  const base = PACKAGE_PRICES[priceId].amounts[currency];
  const fee = surchargeAmountFor(priceId, currency) ?? 0;
  const reference = overrides.reference === undefined ? "HAR-7Q4X" : overrides.reference;
  const lines = [{ description: PACKAGE_PRICES[priceId].name, amount: base }];
  if (fee > 0) lines.push({ description: "International processing fee (2%)", amount: fee });

  return {
    id: "evt_test_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_sim_1",
        object: "checkout.session",
        status: overrides.status ?? "complete",
        payment_status: overrides.paymentStatus ?? "paid",
        currency: overrides.chargedCurrency ?? currency,
        amount_total: overrides.amountTotal ?? base + fee,
        payment_intent: "pi_test_sim_1",
        metadata: { priceId, currency, reference },
        line_items: { data: lines },
      },
    },
  };
}

/** The exact reduction the return page performs on a session. */
function returnPageView(event: ReturnType<typeof webhookEvent>) {
  const session = event.data.object;
  const outcome = classifyOutcome({
    status: session.status,
    paymentStatus: session.payment_status,
  });
  const verification = verifyCheckoutAmount({
    metaPriceId: session.metadata.priceId,
    metaCurrency: session.metadata.currency,
    chargedCurrency: session.currency,
    amountTotal: session.amount_total,
    reference: session.metadata.reference,
    sessionId: session.id,
    paymentIntentId: session.payment_intent,
    referenceFound: session.metadata.reference ? true : null,
  });
  const decision = decideConfirmAction({
    sessionId: session.id,
    outcome,
    reference: session.metadata.reference,
    referenceFound: session.metadata.reference ? true : null,
    record: { paidSessionId: null, paymentState: null },
  });
  return { outcome, verification, decision, session };
}

const matrix = CURRENCY_CODES.flatMap((currency) =>
  PRICE_IDS.map((priceId) => [currency, priceId] as const),
);

describe("simulated Stripe webhook → return page", () => {
  it.each(matrix)(
    "%s / %s: return totals and fee match the recorded amount_total",
    (currency, priceId) => {
      const event = webhookEvent(priceId, currency);
      const { outcome, verification, decision, session } = returnPageView(event);

      const base = PACKAGE_PRICES[priceId].amounts[currency];
      const fee = surchargeAmountFor(priceId, currency) ?? 0;

      // Webhook payload itself is internally consistent.
      const lineSum = session.line_items.data.reduce((sum, l) => sum + l.amount, 0);
      expect(lineSum).toBe(session.amount_total);
      expect(session.amount_total).toBe(amountFor(priceId, currency));

      // Non-USD orders itemize the processing fee separately; USD never does.
      expect(session.line_items.data).toHaveLength(currency === "usd" ? 1 : 2);
      if (currency !== "usd") {
        expect(session.line_items.data[1]).toEqual({
          description: "International processing fee (2%)",
          amount: fee,
        });
      }

      // Return page agrees with the payment intent's amount_total.
      expect(outcome).toBe("paid");
      expect(decision).toEqual({ action: "apply" });
      expect(verification.issues).toEqual([]);
      expect(verification.mismatch).toBeNull();
      expect(verification.expectedAmount).toBe(session.amount_total);
      expect(verification.expectedSurcharge).toBe(fee);
      expect(verification.expectedAmount! - verification.expectedSurcharge!).toBe(base);
      expect(verification.chargedLabel).toBe(money(session.amount_total, currency));
      expect(verification.chargedLabel).toBe(verification.expectedLabel);
    },
  );

  it("flags a webhook that charged the wrong amount", () => {
    const short = amountFor("foundation_song_onetime", "eur")! - 500;
    const { verification } = returnPageView(
      webhookEvent("foundation_song_onetime", "eur", { amountTotal: short }),
    );
    expect(verification.mismatch).not.toBeNull();
    expect(verification.mismatch!.chargedAmount).toBe(short);
    expect(verification.mismatch!.expectedAmount).toBe(amountFor("foundation_song_onetime", "eur"));
    expect(verification.mismatch!.differenceLabel).toBe(`-${money(500, "eur")}`);
    expect(verification.mismatch!.sessionId).toBe("cs_test_sim_1");
    expect(verification.mismatch!.paymentIntentId).toBe("pi_test_sim_1");
    expect(verification.mismatch!.reference).toBe("HAR-7Q4X");
  });

  it("flags a webhook that dropped the processing fee", () => {
    const baseOnly = PACKAGE_PRICES["foundation_song_onetime"].amounts.ngn;
    const { verification } = returnPageView(
      webhookEvent("foundation_song_onetime", "ngn", { amountTotal: baseOnly }),
    );
    expect(verification.mismatch).not.toBeNull();
    expect(verification.expectedSurcharge).toBe(surchargeAmountFor("foundation_song_onetime", "ngn"));
    expect(verification.mismatch!.chargedAmount).toBe(baseOnly);
  });

  it("flags a currency swap between order and charge", () => {
    const { verification } = returnPageView(
      webhookEvent("foundation_song_onetime", "gbp", {
        chargedCurrency: "zar",
        amountTotal: amountFor("foundation_song_onetime", "zar")!,
      }),
    );
    expect(verification.mismatch!.chargedCurrency).toBe("ZAR");
    expect(verification.mismatch!.expectedCurrency).toBe("ZAR");
    expect(verification.issues[0]).toContain("but the order was placed in GBP");
  });

  it("does not settle a submission when the webhook reports an unpaid session", () => {
    const { outcome, decision } = returnPageView(
      webhookEvent("foundation_song_onetime", "usd", { paymentStatus: "unpaid", status: "complete" }),
    );
    expect(outcome).toBe("failed");
    expect(decision).toEqual({ action: "record_attempt", outcome: "failed" });
  });

  it("is idempotent when the same session is replayed", () => {
    const event = webhookEvent("foundation_song_onetime", "usd");
    const session = event.data.object;
    const replay = decideConfirmAction({
      sessionId: session.id,
      outcome: "paid",
      reference: session.metadata.reference,
      referenceFound: true,
      record: { paidSessionId: session.id, paymentState: "paid" },
    });
    expect(replay).toEqual({ action: "already_applied" });
  });
});
