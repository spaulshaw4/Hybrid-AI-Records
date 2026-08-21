import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  DEFAULT_SURCHARGE_BPS,
  PACKAGE_PRICES,
  amountFor,
  formatAmount,
  resetSurchargeBps,
  surchargeAmountFor,
  type CurrencyCode,
} from "@/lib/pricing";
import { verifyCheckoutAmount } from "@/lib/checkout-verification";

/**
 * The return page shows three numbers: base, "incl. 2% processing", and the
 * total Stripe charged (`amount_total`). This suite pins the invariant
 * base + fee === amount_total for the amounts most likely to drift:
 *
 *  - half-cent / half-penny fees (2% landing exactly on x.5 minor units)
 *  - very large values (naira scale, near float precision limits)
 *  - zero and one-minor-unit payments
 */

const PROBE = "__edge_amount_probe__";
const SURCHARGED = CURRENCY_CODES.filter((c) => DEFAULT_SURCHARGE_BPS[c] > 0);

function setProbeBase(base: number) {
  PACKAGE_PRICES[PROBE] = {
    ...PACKAGE_PRICES["foundation_onetime"],
    amounts: CURRENCY_CODES.reduce(
      (acc, code) => ({ ...acc, [code]: base }),
      {} as Record<CurrencyCode, number>,
    ),
  } as (typeof PACKAGE_PRICES)[string];
}

afterEach(() => {
  delete PACKAGE_PRICES[PROBE];
  resetSurchargeBps();
});

/** What the return page would render, given the amount Stripe reports. */
function returnPageView(currency: CurrencyCode, amountTotal: number) {
  const result = verifyCheckoutAmount({
    metaPriceId: PROBE,
    metaCurrency: currency,
    chargedCurrency: currency,
    amountTotal,
    reference: "HAR-4242",
    referenceFound: true,
  });
  const fee = result.expectedSurcharge ?? 0;
  const total = result.expectedAmount ?? 0;
  return {
    ...result,
    fee,
    total,
    base: total - fee,
    baseLabel: formatAmount(total - fee, currency),
    feeLabel: formatAmount(fee, currency),
    totalLabel: formatAmount(total, currency),
  };
}

/**
 * Bases where 2% is exactly half a minor unit (x.5) — the classic
 * banker's-rounding trap. We always round the fee up so the label's total can
 * never under-state what Stripe collected.
 */
const HALF_UNIT_BASES = [25, 75, 125, 175, 225, 1_025, 2_575, 12_575, 99_975];

describe("half-cent / half-penny fees round up and stay additive", () => {
  const cases = SURCHARGED.flatMap((currency) =>
    HALF_UNIT_BASES.map((base) => [currency, base] as const),
  );

  it.each(cases)("%s base %i: fee is the .5 rounded up, base + fee = total", (currency, base) => {
    setProbeBase(base);
    const exactFee = (base * 200) / 10_000;
    expect(exactFee % 1).toBe(0.5); // the case really is a half-unit fee

    const view = returnPageView(currency, amountFor(PROBE, currency)!);
    expect(view.fee).toBe(Math.ceil(exactFee));
    expect(view.base).toBe(base);
    expect(view.base + view.fee).toBe(view.total);
    expect(view.issues).toEqual([]);
  });

  it.each(cases)("%s base %i: charging the rounded-down fee is flagged", (currency, base) => {
    setProbeBase(base);
    const roundedDown = base + Math.floor((base * 200) / 10_000);
    const result = verifyCheckoutAmount({
      metaPriceId: PROBE,
      metaCurrency: currency,
      chargedCurrency: currency,
      amountTotal: roundedDown,
      reference: "HAR-4242",
      referenceFound: true,
    });
    expect(result.mismatch).not.toBeNull();
    expect(result.mismatch?.differenceLabel?.startsWith("-")).toBe(true);
  });
});

/**
 * Large values: naira and rand totals run into the millions/billions of minor
 * units, where naive float math starts losing whole units.
 */
const LARGE_BASES = [1_000_000, 12_345_678, 250_000_000, 999_999_999, 8_640_000_000];

describe("large amounts keep integer precision end to end", () => {
  const cases = SURCHARGED.flatMap((currency) =>
    LARGE_BASES.map((base) => [currency, base] as const),
  );

  it.each(cases)("%s base %i: total is exact and additive", (currency, base) => {
    setProbeBase(base);
    const view = returnPageView(currency, amountFor(PROBE, currency)!);

    const num = BigInt(base) * 10_200n;
    const exact = Number(num % 10_000n === 0n ? num / 10_000n : num / 10_000n + 1n);

    expect(view.total).toBe(exact);
    expect(view.base + view.fee).toBe(view.total);
    expect(Number.isSafeInteger(view.total)).toBe(true);
    expect(view.issues).toEqual([]);
  });

  it.each(cases)("%s base %i: a single-unit shortfall is still caught", (currency, base) => {
    setProbeBase(base);
    const result = verifyCheckoutAmount({
      metaPriceId: PROBE,
      metaCurrency: currency,
      chargedCurrency: currency,
      amountTotal: amountFor(PROBE, currency)! - 1,
      reference: "HAR-4242",
      referenceFound: true,
    });
    expect(result.mismatch).not.toBeNull();
    expect(result.mismatch?.chargedAmount).toBe(result.expectedAmount! - 1);
  });
});

describe("zero and very small payments", () => {
  it.each(SURCHARGED)("%s: a zero base charges zero with a zero fee", (currency) => {
    setProbeBase(0);
    const view = returnPageView(currency, 0);
    expect(view.total).toBe(0);
    expect(view.fee).toBe(0);
    expect(view.base).toBe(0);
    expect(view.issues).toEqual([]);
    expect(view.totalLabel).toBe(view.baseLabel);
  });

  it.each(SURCHARGED)("%s: any charge on a zero base is a mismatch", (currency) => {
    setProbeBase(0);
    const result = verifyCheckoutAmount({
      metaPriceId: PROBE,
      metaCurrency: currency,
      chargedCurrency: currency,
      amountTotal: 1,
      reference: "HAR-4242",
      referenceFound: true,
    });
    expect(result.mismatch).not.toBeNull();
    expect(result.mismatch?.differenceLabel?.startsWith("+")).toBe(true);
  });

  it.each(SURCHARGED)("%s: a one-minor-unit base still collects a whole unit of fee", (currency) => {
    setProbeBase(1);
    const view = returnPageView(currency, amountFor(PROBE, currency)!);
    expect(view.fee).toBe(1);
    expect(view.total).toBe(2);
    expect(view.base + view.fee).toBe(view.total);
    expect(view.issues).toEqual([]);
  });

  it.each(SURCHARGED)("%s: tiny bases 1..60 never drift from amount_total", (currency) => {
    for (let base = 1; base <= 60; base++) {
      setProbeBase(base);
      const total = amountFor(PROBE, currency)!;
      const fee = surchargeAmountFor(PROBE, currency)!;
      expect(base + fee).toBe(total);
      expect(fee).toBe(Math.ceil((base * 200) / 10_000));

      const view = returnPageView(currency, total);
      expect(view.issues).toEqual([]);
      expect(view.base).toBe(base);
    }
  });

  it("USD micro-payments carry no fee at all", () => {
    for (const base of [0, 1, 2, 49, 50]) {
      setProbeBase(base);
      expect(amountFor(PROBE, "usd")).toBe(base);
      expect(surchargeAmountFor(PROBE, "usd")).toBe(0);
    }
  });
});
