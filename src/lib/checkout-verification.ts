/**
 * Pure verification of what Stripe actually charged against the label's own
 * published price table. Kept free of Stripe/Supabase imports so the whole
 * matrix (every package × every currency) can be unit-tested.
 */

import {
  CURRENCIES,
  amountFor,
  formatAmount,
  isCurrencyCode,
  surchargeAmountFor,
} from "@/lib/pricing";

export type AmountMismatch = {
  /** Human-readable list of every discrepancy we detected. */
  issues: string[];
  expectedLabel: string | null;
  chargedLabel: string | null;
  /** Currency the price table quoted, upper-case. */
  expectedCurrency: string | null;
  /** Currency Stripe actually charged, upper-case. */
  chargedCurrency: string | null;
  /** Expected total in minor units. */
  expectedAmount: number | null;
  /** Amount Stripe charged, in minor units. */
  chargedAmount: number | null;
  /** Processing-fee portion of the expected total, in minor units. */
  expectedSurcharge: number | null;
  /** Difference (charged - expected) in minor units when both are known. */
  differenceLabel: string | null;
  /** Submission reference carried on the session. */
  reference: string | null;
  /** Stripe Checkout Session id. */
  sessionId: string | null;
  /** Stripe PaymentIntent id, when the session produced one. */
  paymentIntentId: string | null;
};

/**
 * Receipt-style label for an amount, formatted in the *settlement* currency:
 * its own narrow symbol (R, £, €, ₦, $) and its own decimal convention —
 * two decimals everywhere except NGN, which settles in whole naira.
 */
export function money(minor: number, currency: string): string {
  const code = currency.toLowerCase();
  if (isCurrencyCode(code)) {
    return formatAmount(minor, code, {
      locale: CURRENCIES[code].locale,
      decimals: code !== "ngn",
    });
  }
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(minor / 100);
}

export type VerifyInput = {
  /** `priceId` stored in session metadata when checkout was created. */
  metaPriceId: string | null;
  /** `currency` stored in session metadata when checkout was created. */
  metaCurrency: string | null;
  /** Currency Stripe reports on the completed session. */
  chargedCurrency: string | null;
  /** `amount_total` Stripe reports, in minor units. */
  amountTotal: number | null;
  /** Track submission reference carried on the session, if any. */
  reference: string | null;
  /** Stripe Checkout Session id, surfaced on the review page. */
  sessionId?: string | null;
  /** Stripe PaymentIntent id, surfaced on the review page. */
  paymentIntentId?: string | null;
  /**
   * Whether that reference resolved to a real submission row. `null` when the
   * lookup was skipped or failed (we don't accuse Stripe of a bad reference
   * because our own database hiccuped).
   */
  referenceFound: boolean | null;
};

export type VerifyResult = {
  issues: string[];
  expectedLabel: string | null;
  chargedLabel: string | null;
  /** Expected total in minor units, when we could resolve one. */
  expectedAmount: number | null;
  /** The 2% processing portion of the expected total, in minor units. */
  expectedSurcharge: number | null;
  mismatch: AmountMismatch | null;
};

export function verifyCheckoutAmount(input: VerifyInput): VerifyResult {
  const issues: string[] = [];
  let expectedLabel: string | null = null;
  let expectedAmount: number | null = null;
  let expectedSurcharge: number | null = null;

  const chargedCurrency = input.chargedCurrency?.toLowerCase() ?? null;
  const metaCurrency = input.metaCurrency?.toLowerCase() ?? null;

  const chargedLabel =
    input.amountTotal != null && chargedCurrency
      ? money(input.amountTotal, chargedCurrency)
      : null;

  if (metaCurrency && chargedCurrency && metaCurrency !== chargedCurrency) {
    issues.push(
      `Charged in ${chargedCurrency.toUpperCase()} but the order was placed in ${metaCurrency.toUpperCase()}.`,
    );
  }

  const verifyCurrency = isCurrencyCode(chargedCurrency)
    ? chargedCurrency
    : isCurrencyCode(metaCurrency)
      ? metaCurrency
      : null;

  if (input.metaPriceId && verifyCurrency) {
    const expected = amountFor(input.metaPriceId, verifyCurrency);
    if (expected === null) {
      issues.push("We could not find a published price for this order.");
    } else {
      expectedAmount = expected;
      expectedSurcharge = surchargeAmountFor(input.metaPriceId, verifyCurrency);
      expectedLabel = money(expected, verifyCurrency);
      if (input.amountTotal != null && input.amountTotal !== expected) {
        issues.push(
          `Stripe charged ${money(input.amountTotal, chargedCurrency ?? verifyCurrency)} but the listed total for this package is ${expectedLabel}.`,
        );
      }
    }
  }

  if (input.reference && input.referenceFound === false) {
    issues.push(`No submission was found for reference ${input.reference}.`);
  }

  return {
    issues,
    expectedLabel,
    chargedLabel,
    expectedAmount,
    expectedSurcharge,
    mismatch: issues.length
      ? {
          issues,
          expectedLabel,
          chargedLabel,
          expectedCurrency: verifyCurrency ? verifyCurrency.toUpperCase() : null,
          chargedCurrency: chargedCurrency ? chargedCurrency.toUpperCase() : null,
          expectedAmount,
          chargedAmount: input.amountTotal ?? null,
          expectedSurcharge,
          differenceLabel:
            expectedAmount != null && input.amountTotal != null && (chargedCurrency ?? verifyCurrency)
              ? `${input.amountTotal - expectedAmount >= 0 ? "+" : "-"}${money(
                  Math.abs(input.amountTotal - expectedAmount),
                  (chargedCurrency ?? verifyCurrency) as string,
                )}`
              : null,
          reference: input.reference ?? null,
          sessionId: input.sessionId ?? null,
          paymentIntentId: input.paymentIntentId ?? null,
        }
      : null,
  };
}
