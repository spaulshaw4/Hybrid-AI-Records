import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  CURRENCY_SURCHARGE_BPS,
  DEFAULT_SURCHARGE_BPS,
  PACKAGE_PRICES,
  amountFor,
  applySurchargeBps,
  resetSurchargeBps,
  surchargeAmountFor,
  type CurrencyCode,
} from "@/lib/pricing";
import { verifyCheckoutAmount } from "@/lib/checkout-verification";

/**
 * Rounding is the only place a checkout total can silently drift from what
 * Stripe actually charges: we bill `base + ceil(base * bps / 10000)` as two
 * separate line items, and Stripe sums those integers itself. If our fee ever
 * rounds differently from the itemisation, `amount_total` won't match and the
 * return page flags a false mismatch (or worse, misses a real one).
 *
 * These tests pin the exact-integer contract for synthetic bases chosen to sit
 * on every rounding boundary, then replay them through the same verification
 * used by the return page.
 */

const PROBE = "__rounding_probe__";

/** Exact expected total using BigInt, immune to float error at NGN scale. */
function exactTotal(base: number, bps: number): number {
  const num = BigInt(base) * BigInt(10_000 + bps);
  const q = num / 10_000n;
  return Number(num % 10_000n === 0n ? q : q + 1n);
}

/** Registers a synthetic package whose base amount is identical in every currency. */
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

/**
 * Bases picked for their remainder against 2% (200 bps): exact multiples of 50
 * land on a whole minor unit, everything else must round *up* so we never
 * under-collect the fee. 1 and 24 are the "fee rounds to a full unit from
 * almost nothing" cases; the large values probe float precision.
 */
const EDGE_BASES = [
  1, 24, 25, 49, 50, 51, 99, 100, 149, 150, 4_999, 5_000, 5_001, 99_999, 100_000, 720_000,
  1_234_567, 64_000_000, 99_999_999,
];

describe("2% fee rounding is exact for every currency", () => {
  const cases = CURRENCY_CODES.filter((c) => DEFAULT_SURCHARGE_BPS[c] > 0).flatMap((currency) =>
    EDGE_BASES.map((base) => [currency, base] as const),
  );

  it.each(cases)("%s base %i: total = base + ceil(2%%), fee never rounds down", (currency, base) => {
    setProbeBase(base);

    const total = amountFor(PROBE, currency)!;
    const fee = surchargeAmountFor(PROBE, currency)!;

    // Integer-exact: no fractional minor units ever reach Stripe.
    expect(Number.isInteger(total)).toBe(true);
    expect(Number.isInteger(fee)).toBe(true);

    // Matches the BigInt reference calculation exactly.
    expect(total).toBe(exactTotal(base, 200));

    // The itemised line items (base + fee) sum to the charged total exactly.
    expect(base + fee).toBe(total);

    // Always rounds up, never down, and never overshoots by more than a unit.
    expect(fee).toBeGreaterThanOrEqual(Math.floor((base * 200) / 10_000));
    expect(fee - (base * 200) / 10_000).toBeGreaterThanOrEqual(0);
    expect(fee - (base * 200) / 10_000).toBeLessThan(1);
  });
});

describe("ZAR rounding boundaries", () => {
  it("charges a whole extra cent when 2% lands mid-cent", () => {
    setProbeBase(2_575); // R25.75 -> fee 51.5 cents -> must round to 52
    expect(surchargeAmountFor(PROBE, "zar")).toBe(52);
    expect(amountFor(PROBE, "zar")).toBe(2_627);
  });

  it("adds no extra cent when 2% is already whole", () => {
    setProbeBase(2_550); // fee is exactly 51 cents
    expect(surchargeAmountFor(PROBE, "zar")).toBe(51);
    expect(amountFor(PROBE, "zar")).toBe(2_601);
  });

  it("still collects one cent on a one-cent base", () => {
    setProbeBase(1);
    expect(surchargeAmountFor(PROBE, "zar")).toBe(1);
    expect(amountFor(PROBE, "zar")).toBe(2);
  });

  it.each(Object.keys(PACKAGE_PRICES))("%s real ZAR price rounds exactly", (priceId) => {
    const base = PACKAGE_PRICES[priceId].amounts.zar;
    expect(amountFor(priceId, "zar")).toBe(exactTotal(base, 200));
    expect(base + surchargeAmountFor(priceId, "zar")!).toBe(amountFor(priceId, "zar"));
  });
});

describe("NGN whole-naira scale keeps integer precision", () => {
  it.each([64_000_000, 99_999_999, 1_000_000_001])("base %i is exact at naira scale", (base) => {
    setProbeBase(base);
    const total = amountFor(PROBE, "ngn")!;
    expect(total).toBe(exactTotal(base, 200));
    expect(total - base).toBe(surchargeAmountFor(PROBE, "ngn"));
  });
});

describe("USD is never surcharged, so rounding cannot drift", () => {
  it.each(EDGE_BASES)("base %i charges the published price exactly", (base) => {
    setProbeBase(base);
    expect(amountFor(PROBE, "usd")).toBe(base);
    expect(surchargeAmountFor(PROBE, "usd")).toBe(0);
  });
});

describe("admin-configured rates round the same way", () => {
  beforeEach(() => {
    // Deliberately awkward rates: 0.01%, 1.75%, and the 15% ceiling.
    applySurchargeBps({ eur: 1, gbp: 175, zar: 1_500, ngn: 0 });
  });

  it.each([1, 49, 50, 333, 5_001, 99_999])("base %i stays integer-exact under custom bps", (base) => {
    setProbeBase(base);
    for (const currency of CURRENCY_CODES) {
      const bps = CURRENCY_SURCHARGE_BPS[currency];
      const total = amountFor(PROBE, currency)!;
      expect(total).toBe(bps === 0 ? base : exactTotal(base, bps));
      expect(base + surchargeAmountFor(PROBE, currency)!).toBe(total);
    }
  });
});

describe("return-page verification accepts the rounded total and rejects neighbours", () => {
  const currencies = CURRENCY_CODES.filter((c) => DEFAULT_SURCHARGE_BPS[c] > 0);
  const cases = currencies.flatMap((currency) =>
    [1, 49, 2_575, 720_000, 64_000_000].map((base) => [currency, base] as const),
  );

  it.each(cases)("%s base %i verifies clean at the rounded-up total", (currency, base) => {
    setProbeBase(base);
    const total = amountFor(PROBE, currency)!;

    const ok = verifyCheckoutAmount({
      metaPriceId: PROBE,
      metaCurrency: currency,
      chargedCurrency: currency,
      amountTotal: total,
      reference: "HAR-9001",
      referenceFound: true,
    });
    expect(ok.issues).toEqual([]);
    expect(ok.mismatch).toBeNull();
    expect(ok.expectedAmount).toBe(total);
    expect(ok.expectedSurcharge).toBe(total - base);
  });

  it.each(cases)("%s base %i flags a one-minor-unit rounding drift", (currency, base) => {
    setProbeBase(base);
    const total = amountFor(PROBE, currency)!;

    for (const drift of [-1, 1]) {
      const result = verifyCheckoutAmount({
        metaPriceId: PROBE,
        metaCurrency: currency,
        chargedCurrency: currency,
        amountTotal: total + drift,
        reference: "HAR-9001",
        referenceFound: true,
      });
      expect(result.mismatch).not.toBeNull();
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it.each(cases)("%s base %i flags a total that truncated the fee instead of rounding up", (currency, base) => {
    setProbeBase(base);
    const truncated = base + Math.floor((base * 200) / 10_000);
    const expected = amountFor(PROBE, currency)!;
    if (truncated === expected) return; // fee was already whole — nothing to truncate

    const result = verifyCheckoutAmount({
      metaPriceId: PROBE,
      metaCurrency: currency,
      chargedCurrency: currency,
      amountTotal: truncated,
      reference: "HAR-9001",
      referenceFound: true,
    });
    expect(result.mismatch).not.toBeNull();
  });
});
