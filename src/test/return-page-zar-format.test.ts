/**
 * Return-page money formatting, settled in ZAR.
 *
 * The confirmation and needs-review panels label every amount with
 * `money()` from checkout-verification. These tests pin the rand symbol,
 * decimal places, grouping, and — critically — that formatting follows the
 * *settlement* currency Stripe reported, not the currency the order was
 * quoted in or the language the visitor is browsing in.
 */
import { afterEach, describe, expect, it } from "vitest";
import { money, verifyCheckoutAmount } from "@/lib/checkout-verification";
import {
  PACKAGE_PRICES,
  amountFor,
  setDisplayLocale,
  surchargeAmountFor,
} from "@/lib/pricing";

const PRICE_IDS = Object.keys(PACKAGE_PRICES);

/** Non-breaking / narrow no-break spaces so assertions stay readable. */
const normalize = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");

afterEach(() => setDisplayLocale(null));

describe("ZAR labels on the return page", () => {
  it("uses the rand symbol, comma decimals and space grouping", () => {
    expect(normalize(money(91_800, "zar"))).toBe("R 918,00");
    expect(normalize(money(1_800, "zar"))).toBe("R 18,00");
    expect(normalize(money(9_180_00, "zar"))).toBe("R 9 180,00");
  });

  it("always shows exactly two decimals, including whole amounts", () => {
    for (const minor of [90_000, 91_800, 100, 1]) {
      const label = normalize(money(minor, "zar"));
      expect(label.startsWith("R")).toBe(true);
      expect(label).toMatch(/,\d{2}$/);
    }
  });

  it("never renders the ISO code instead of the symbol", () => {
    expect(money(91_800, "zar")).not.toContain("ZAR");
  });

  it.each(PRICE_IDS)("%s: total and 2% fee are both rand-formatted", (priceId) => {
    const total = amountFor(priceId, "zar")!;
    const fee = surchargeAmountFor(priceId, "zar")!;
    const base = PACKAGE_PRICES[priceId].amounts.zar;

    for (const [minor, expectedMajor] of [
      [total, total / 100],
      [fee, fee / 100],
      [base, base / 100],
    ] as const) {
      const label = normalize(money(minor, "zar"));
      expect(label).toBe(`R ${expectedMajor.toFixed(2).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d)(?=.*,))/g, " ")}`);
    }
  });

  it("formats the verification labels a settled ZAR order shows", () => {
    const priceId = PRICE_IDS[0];
    const total = amountFor(priceId, "zar")!;
    const result = verifyCheckoutAmount({
      metaPriceId: priceId,
      metaCurrency: "zar",
      chargedCurrency: "zar",
      amountTotal: total,
      reference: "HAR-7Q4X",
      referenceFound: true,
    });
    expect(result.mismatch).toBeNull();
    expect(normalize(result.chargedLabel!)).toBe(normalize(money(total, "zar")));
    expect(result.expectedLabel).toBe(result.chargedLabel);
    expect(result.expectedLabel!.startsWith("R")).toBe(true);
    expect(result.expectedSurcharge).toBe(surchargeAmountFor(priceId, "zar"));
  });

  it("labels a ZAR mismatch, its difference and the fee in rand", () => {
    const priceId = PRICE_IDS[0];
    const expected = amountFor(priceId, "zar")!;
    const result = verifyCheckoutAmount({
      metaPriceId: priceId,
      metaCurrency: "zar",
      chargedCurrency: "zar",
      amountTotal: expected - 1_500,
      reference: "HAR-7Q4X",
      sessionId: "cs_test_zar",
      paymentIntentId: "pi_test_zar",
      referenceFound: true,
    });
    const mismatch = result.mismatch!;
    expect(mismatch.expectedCurrency).toBe("ZAR");
    expect(mismatch.chargedCurrency).toBe("ZAR");
    expect(normalize(mismatch.differenceLabel!)).toBe("-R 15,00");
    expect(normalize(mismatch.chargedLabel!)).toBe(normalize(money(expected - 1_500, "zar")));
    expect(normalize(mismatch.expectedLabel!)).toBe(normalize(money(expected, "zar")));
  });
});

describe("formatting follows the settlement currency", () => {
  it("shows the settled currency's symbol when it differs from the quoted one", () => {
    const result = verifyCheckoutAmount({
      metaPriceId: PRICE_IDS[0],
      metaCurrency: "gbp",
      chargedCurrency: "zar",
      amountTotal: amountFor(PRICE_IDS[0], "zar")!,
      reference: "HAR-7Q4X",
      referenceFound: true,
    });
    expect(result.mismatch!.chargedLabel!.startsWith("R")).toBe(true);
    expect(result.mismatch!.chargedLabel).not.toContain("£");
  });

  it("keeps each currency's own symbol and decimal rules", () => {
    expect(normalize(money(91_800, "zar"))).toBe("R 918,00");
    expect(money(5_000, "usd")).toBe("$50.00");
    expect(normalize(money(4_590, "eur"))).toBe("45,90 €");
    expect(money(4_000, "gbp")).toBe("£40.00");
    // NGN settles in whole naira — no decimals at all.
    expect(normalize(money(8_160_000, "ngn"))).toBe("₦81,600");
    expect(money(8_160_000, "ngn")).not.toContain(".");
  });

  it("does not change ZAR receipt formatting when the UI language changes", () => {
    const baseline = money(91_800, "zar");
    for (const locale of ["ar", "lt", "pt", "fr", "ha"]) {
      setDisplayLocale(locale);
      expect(money(91_800, "zar")).toBe(baseline);
    }
  });

  it("renders Latin digits even under an Arabic UI locale", () => {
    setDisplayLocale("ar");
    expect(money(91_800, "zar")).toMatch(/[0-9]/);
    expect(money(91_800, "zar")).not.toMatch(/[\u0660-\u0669]/);
  });
});
