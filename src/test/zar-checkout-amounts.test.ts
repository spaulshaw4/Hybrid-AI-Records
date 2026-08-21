import { describe, expect, it } from "vitest";
import {
  CURRENCY_CODES,
  PACKAGE_PRICES,
  amountFor,
  surchargeAmountFor,
  surchargePercent,
  type CurrencyCode,
} from "@/lib/pricing";
import { money, verifyCheckoutAmount } from "@/lib/checkout-verification";

const PRICE_IDS = Object.keys(PACKAGE_PRICES);

/** A Stripe session that charged exactly what our table says it should. */
function goodSession(priceId: string, currency: CurrencyCode) {
  return {
    metaPriceId: priceId,
    metaCurrency: currency,
    chargedCurrency: currency,
    amountTotal: amountFor(priceId, currency)!,
    reference: "HAR-1234",
    referenceFound: true,
  };
}

describe("ZAR checkout totals", () => {
  it.each(PRICE_IDS)("%s adds exactly 2% processing on top of the base price", (priceId) => {
    const base = PACKAGE_PRICES[priceId].amounts.zar;
    const total = amountFor(priceId, "zar")!;
    const fee = surchargeAmountFor(priceId, "zar")!;

    expect(surchargePercent("zar")).toBe(2);
    expect(fee).toBe(Math.ceil(base * 1.02) - base);
    expect(base + fee).toBe(total);
    expect(total).toBe(Math.ceil(base * 1.02));
  });

  it.each(PRICE_IDS)("%s ZAR total is verified against the Stripe charge", (priceId) => {
    const result = verifyCheckoutAmount(goodSession(priceId, "zar"));
    expect(result.issues).toEqual([]);
    expect(result.mismatch).toBeNull();
    expect(result.expectedAmount).toBe(amountFor(priceId, "zar"));
    expect(result.expectedSurcharge).toBe(surchargeAmountFor(priceId, "zar"));
    expect(result.chargedLabel).toBe(result.expectedLabel);
    expect(result.expectedLabel).toBe(money(amountFor(priceId, "zar")!, "zar"));
  });
});

describe("currency × package matrix", () => {
  const matrix = CURRENCY_CODES.flatMap((currency) =>
    PRICE_IDS.map((priceId) => [currency, priceId] as const),
  );

  it.each(matrix)("%s / %s passes verification when Stripe matches the table", (currency, priceId) => {
    const result = verifyCheckoutAmount(goodSession(priceId, currency));
    expect(result.mismatch).toBeNull();
    const expectedFee = currency === "usd" ? 0 : surchargeAmountFor(priceId, currency)!;
    expect(result.expectedSurcharge).toBe(expectedFee);
    expect(result.expectedAmount).toBe(
      PACKAGE_PRICES[priceId].amounts[currency] + expectedFee,
    );
  });
});

describe("mismatch detection on the return page payload", () => {
  const priceId = "music_video_4k_onetime";

  it("flags a ZAR charge that omitted the 2% processing fee", () => {
    const base = PACKAGE_PRICES[priceId].amounts.zar;
    const result = verifyCheckoutAmount({
      ...goodSession(priceId, "zar"),
      amountTotal: base,
    });
    expect(result.mismatch).not.toBeNull();
    expect(result.issues.join(" ")).toContain("but the listed total for this package is");
    expect(result.chargedLabel).toBe(money(base, "zar"));
    expect(result.expectedLabel).toBe(money(amountFor(priceId, "zar")!, "zar"));
  });

  it("flags a ZAR order that Stripe settled in another currency", () => {
    const result = verifyCheckoutAmount({
      ...goodSession(priceId, "zar"),
      chargedCurrency: "usd",
      amountTotal: amountFor(priceId, "usd")!,
    });
    expect(result.issues[0]).toBe("Charged in USD but the order was placed in ZAR.");
  });

  it("flags a ZAR payment whose reference has no submission", () => {
    const result = verifyCheckoutAmount({
      ...goodSession(priceId, "zar"),
      referenceFound: false,
    });
    expect(result.issues).toEqual(["No submission was found for reference HAR-1234."]);
  });

  it("does not blame the reference when the lookup was skipped", () => {
    const result = verifyCheckoutAmount({
      ...goodSession(priceId, "zar"),
      referenceFound: null,
    });
    expect(result.mismatch).toBeNull();
  });

  it("flags an unknown package even in ZAR", () => {
    const result = verifyCheckoutAmount({
      ...goodSession(priceId, "zar"),
      metaPriceId: "not_a_real_package",
    });
    expect(result.issues).toEqual(["We could not find a published price for this order."]);
  });
});
