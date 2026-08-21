/**
 * Return-page totals and 2% fee formatting, parameterized across every
 * settlement currency we accept *besides* ZAR (which has its own suite in
 * return-page-zar-format.test.ts).
 *
 * For each currency the matrix pins:
 *  - the narrow symbol and its placement,
 *  - decimal count and decimal/grouping separators,
 *  - that the surcharge line equals total − base at the configured bps,
 *  - that the confirmation and mismatch labels the return page renders come
 *    out in the *settlement* currency, unaffected by the visitor's language.
 */
import { afterEach, describe, expect, it } from "vitest";
import { money, verifyCheckoutAmount } from "@/lib/checkout-verification";
import {
  CURRENCY_CODES,
  PACKAGE_PRICES,
  amountFor,
  resetSurchargeBps,
  setDisplayLocale,
  surchargeAmountFor,
  surchargePercent,
  type CurrencyCode,
} from "@/lib/pricing";

const PRICE_IDS = Object.keys(PACKAGE_PRICES);

/** Normalize NBSP / narrow NBSP so assertions stay readable. */
const normalize = (value: string) => value.replace(/[\u00a0\u202f]/g, " ");

type CurrencyExpectation = {
  symbol: string;
  /** Where the symbol sits relative to the digits. */
  position: "prefix" | "suffix";
  decimals: 0 | 2;
  decimalSep: "." | ",";
  groupSep: "," | "." | " ";
  /** A known amount in minor units and its exact rendered label. */
  sample: [minor: number, label: string];
  /** Thousands-grouped sample, to pin the group separator. */
  grouped: [minor: number, label: string];
};

/** Every settlement currency except ZAR. */
const MATRIX: Record<Exclude<CurrencyCode, "zar">, CurrencyExpectation> = {
  usd: {
    symbol: "$",
    position: "prefix",
    decimals: 2,
    decimalSep: ".",
    groupSep: ",",
    sample: [5_000, "$50.00"],
    grouped: [150_000, "$1,500.00"],
  },
  eur: {
    symbol: "€",
    position: "suffix",
    decimals: 2,
    decimalSep: ",",
    groupSep: ".",
    sample: [4_590, "45,90 €"],
    grouped: [142_800, "1.428,00 €"],
  },
  gbp: {
    symbol: "£",
    position: "prefix",
    decimals: 2,
    decimalSep: ".",
    groupSep: ",",
    sample: [4_080, "£40.80"],
    grouped: [122_400, "£1,224.00"],
  },
  ngn: {
    symbol: "₦",
    position: "prefix",
    decimals: 0,
    decimalSep: ".",
    groupSep: ",",
    sample: [8_160_000, "₦81,600"],
    grouped: [244_800_000, "₦2,448,000"],
  },
};

/** Digits-only portion of a rendered label (symbol and spaces stripped). */
const digitsOf = (label: string) => normalize(label).replace(/[^\d.,]/g, "").trim();

const expectDecimalTail = (label: string, spec: CurrencyExpectation) => {
  const digits = digitsOf(label);
  if (spec.decimals === 0) {
    expect(digits).toMatch(/^[\d,. ]*\d$/);
    expect(digits).not.toMatch(/[.,]\d{1,2}$/);
  } else {
    expect(digits).toMatch(new RegExp(`\\${spec.decimalSep}\\d{2}$`));
  }
};

const CURRENCIES_UNDER_TEST = Object.keys(MATRIX) as Exclude<CurrencyCode, "zar">[];

const cases = CURRENCIES_UNDER_TEST.map((code) => [code, MATRIX[code]] as const);

afterEach(() => {
  setDisplayLocale(null);
  resetSurchargeBps();
});

describe("settlement currency coverage", () => {
  it("covers every supported currency beyond ZAR", () => {
    expect([...CURRENCIES_UNDER_TEST, "zar"].sort()).toEqual([...CURRENCY_CODES].sort());
  });
});

describe.each(cases)("%s return-page formatting", (code, spec) => {
  it("renders the expected symbol, decimals and separators", () => {
    const [minor, label] = spec.sample;
    expect(normalize(money(minor, code))).toBe(label);
  });

  it("groups thousands with the currency's own separator", () => {
    const [minor, label] = spec.grouped;
    expect(normalize(money(minor, code))).toBe(label);
  });

  it("places the symbol on the expected side and never shows the ISO code", () => {
    const label = normalize(money(spec.sample[0], code));
    if (spec.position === "prefix") expect(label.startsWith(spec.symbol)).toBe(true);
    else expect(label.endsWith(spec.symbol)).toBe(true);
    expect(label).not.toContain(code.toUpperCase());
  });

  it("uses a consistent decimal count on every published amount", () => {
    for (const priceId of PRICE_IDS) {
      const label = normalize(money(amountFor(priceId, code)!, code));
      if (spec.decimals === 0) expect(label).not.toContain(".");
      else expect(label).toContain(spec.decimalSep);
      expectDecimalTail(label, spec);
    }
  });

  it.each(PRICE_IDS)(`%s: total = base + ${"2%"} fee, all three formatted alike`, (priceId) => {
    const base = PACKAGE_PRICES[priceId].amounts[code];
    const total = amountFor(priceId, code)!;
    const fee = surchargeAmountFor(priceId, code)!;

    expect(total).toBe(base + fee);
    expect(surchargePercent(code)).toBe(code === "usd" ? 0 : 2);
    expect(fee).toBe(code === "usd" ? 0 : Math.ceil((base * 10_200) / 10_000) - base);

    for (const minor of [base, fee, total]) {
      const label = normalize(money(minor, code));
      expect(label).toContain(spec.symbol);
      expectDecimalTail(label, spec);
    }
  });

  it("labels a matching charge with the settled total and fee", () => {
    const priceId = PRICE_IDS[0];
    const total = amountFor(priceId, code)!;
    const result = verifyCheckoutAmount({
      metaPriceId: priceId,
      metaCurrency: code,
      chargedCurrency: code,
      amountTotal: total,
      reference: "HAR-4K2P",
      referenceFound: true,
    });

    expect(result.mismatch).toBeNull();
    expect(result.issues).toEqual([]);
    expect(result.expectedAmount).toBe(total);
    expect(result.expectedSurcharge).toBe(surchargeAmountFor(priceId, code));
    expect(normalize(result.chargedLabel!)).toBe(normalize(money(total, code)));
    expect(result.expectedLabel).toBe(result.chargedLabel);
  });

  it("labels an underpayment mismatch in the same currency", () => {
    const priceId = PRICE_IDS[2];
    const expected = amountFor(priceId, code)!;
    const short = code === "ngn" ? 100_000 : 1_500;
    const result = verifyCheckoutAmount({
      metaPriceId: priceId,
      metaCurrency: code,
      chargedCurrency: code,
      amountTotal: expected - short,
      reference: "HAR-4K2P",
      sessionId: `cs_test_${code}`,
      paymentIntentId: `pi_test_${code}`,
      referenceFound: true,
    });

    const mismatch = result.mismatch!;
    expect(mismatch.expectedCurrency).toBe(code.toUpperCase());
    expect(mismatch.chargedCurrency).toBe(code.toUpperCase());
    expect(normalize(mismatch.expectedLabel!)).toBe(normalize(money(expected, code)));
    expect(normalize(mismatch.chargedLabel!)).toBe(normalize(money(expected - short, code)));
    expect(normalize(mismatch.differenceLabel!)).toBe(`-${normalize(money(short, code))}`);
  });

  it("formats by the settled currency even when the order was quoted elsewhere", () => {
    const priceId = PRICE_IDS[1];
    const quoted: CurrencyCode = code === "usd" ? "eur" : "usd";
    const result = verifyCheckoutAmount({
      metaPriceId: priceId,
      metaCurrency: quoted,
      chargedCurrency: code,
      amountTotal: amountFor(priceId, code)!,
      reference: "HAR-4K2P",
      referenceFound: true,
    });
    const label = normalize(result.mismatch!.chargedLabel!);
    expect(label).toContain(spec.symbol);
    // The quoted currency's symbol must not leak into the settled label.
    expect(label).not.toContain(MATRIX[quoted as Exclude<CurrencyCode, "zar">].symbol);
  });

  it("keeps receipt formatting stable across UI languages", () => {
    const total = amountFor(PRICE_IDS[0], code)!;
    const baseline = money(total, code);
    for (const locale of ["ar", "lt", "pt", "fr", "sw", "ig", "yo", "ha", "en"]) {
      setDisplayLocale(locale);
      expect(money(total, code)).toBe(baseline);
    }
  });

  it("renders Latin digits under an Arabic UI locale", () => {
    setDisplayLocale("ar");
    const label = money(amountFor(PRICE_IDS[0], code)!, code);
    expect(label).toMatch(/[0-9]/);
    expect(label).not.toMatch(/[\u0660-\u0669]/);
  });
});
