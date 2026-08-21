/**
 * Single source of truth for what every package costs, in every currency we
 * accept. The server reads the same table when it builds a Stripe checkout
 * session, so a browser can never dictate the amount it is charged.
 *
 * Amounts are in the currency's *minor* unit (cents / kobo).
 */

import { convertFromUsd } from "@/lib/fx";

export type CurrencyCode = "usd" | "eur" | "gbp" | "ngn" | "zar";


export type CurrencyInfo = {
  code: CurrencyCode;
  label: string;
  symbol: string;
  locale: string;
  /** Countries that default to this currency (ISO-3166 alpha-2). */
  countries: string[];
};

export const CURRENCIES: Record<CurrencyCode, CurrencyInfo> = {
  usd: { code: "usd", label: "US Dollar", symbol: "$", locale: "en-US", countries: [] },
  eur: {
    code: "eur",
    label: "Euro",
    symbol: "€",
    locale: "de-DE",
    countries: [
      "AT", "BE", "HR", "CY", "EE", "FI", "FR", "DE", "GR", "IE", "IT", "LV",
      "LT", "LU", "MT", "NL", "PT", "SK", "SI", "ES", "MC", "AD", "SM", "VA",
    ],
  },
  gbp: {
    code: "gbp",
    label: "British Pound",
    symbol: "£",
    locale: "en-GB",
    countries: ["GB", "GG", "IM", "JE"],
  },
  ngn: { code: "ngn", label: "Nigerian Naira", symbol: "₦", locale: "en-NG", countries: ["NG"] },
  zar: {
    code: "zar",
    label: "South African Rand",
    symbol: "R",
    locale: "en-ZA",
    countries: ["ZA", "NA", "LS", "SZ"],
  },
};

export const CURRENCY_CODES: CurrencyCode[] = ["usd", "eur", "gbp", "ngn", "zar"];

export const DEFAULT_CURRENCY: CurrencyCode = "usd";

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === "string" && (CURRENCY_CODES as string[]).includes(value);
}

/** Maps a visitor's country to the currency we should show them. */
export function currencyForCountry(country?: string | null): CurrencyCode {
  if (!country) return DEFAULT_CURRENCY;
  const upper = country.trim().toUpperCase();
  for (const code of CURRENCY_CODES) {
    if (CURRENCIES[code].countries.includes(upper)) return code;
  }
  return DEFAULT_CURRENCY;
}

export type PackagePrice = {
  /** Human name shown in Stripe and on receipts. */
  name: string;
  /** Amount in minor units, per currency. */
  amounts: Record<CurrencyCode, number>;
};

/**
 * Every purchasable price ID on the site. USD is the master rate; EUR and NGN
 * are the label's published local prices (edit these numbers to re-price —
 * nothing else needs to change).
 */
export const PACKAGE_PRICES: Record<string, PackagePrice> = {
  foundation_song_onetime: {
    name: "The Foundation — 1 Track (Distribution)",
    amounts: { usd: 5_000, eur: 4_500, gbp: 4_000, ngn: 8_000_000, zar: 90_000 },
  },
  foundation_10_onetime: {
    name: "The Foundation — 10 Tracks (Distribution)",
    amounts: { usd: 50_000, eur: 45_000, gbp: 40_000, ngn: 80_000_000, zar: 900_000 },
  },
  visual_push_song_onetime: {
    name: "The Visual Push — 1 Track",
    amounts: { usd: 10_000, eur: 9_000, gbp: 8_000, ngn: 16_000_000, zar: 180_000 },
  },
  visual_push_10_onetime: {
    name: "The Visual Push — 10 Tracks + Music Video",
    amounts: { usd: 100_000, eur: 90_000, gbp: 80_000, ngn: 160_000_000, zar: 1_800_000 },
  },
  full_hybrid_song_onetime: {
    name: "The Full Hybrid Experience — 1 Track",
    amounts: { usd: 15_000, eur: 14_000, gbp: 12_000, ngn: 24_000_000, zar: 270_000 },
  },
  full_hybrid_10_onetime: {
    name: "The Full Hybrid Experience — 10 Tracks + 2 Videos",
    amounts: { usd: 150_000, eur: 140_000, gbp: 120_000, ngn: 240_000_000, zar: 2_700_000 },
  },
  music_video_hd_onetime: {
    name: "Standard HD Music Video",
    amounts: { usd: 30_000, eur: 27_500, gbp: 24_000, ngn: 48_000_000, zar: 540_000 },
  },
  music_video_4k_onetime: {
    name: "High-End 4K Cinematic Music Video",
    amounts: { usd: 40_000, eur: 37_000, gbp: 32_000, ngn: 64_000_000, zar: 720_000 },
  },
  // Portal video production packages (Step 1 → Step 3 checkout).
  standard_video_onetime: {
    name: "Standard Video Package — HD Music Video",
    amounts: { usd: 35_000, eur: 32_500, gbp: 28_000, ngn: 56_000_000, zar: 630_000 },
  },
  video_4k_onetime: {
    name: "4K HD Video Package — 4K Music Video",
    amounts: { usd: 40_000, eur: 37_000, gbp: 32_000, ngn: 64_000_000, zar: 720_000 },
  },
};

/**
 * Cross-border / FX processing fee we pass through on non-USD checkouts, in
 * basis points (200 = 2%). USD settles natively, so it carries no surcharge.
 */
export const DEFAULT_SURCHARGE_BPS: Record<CurrencyCode, number> = {
  usd: 0,
  eur: 200,
  gbp: 200,
  ngn: 200,
  zar: 200,
};

/** Hard limit so a mistyped admin value can never invent a 900% fee. */
export const MAX_SURCHARGE_BPS = 1_500;

/**
 * Live rates. Admin-configured values from the database are applied over the
 * defaults at boot (browser) and per request (server), so every pricing helper
 * below reflects the current setting without any call-site changes.
 */
export const CURRENCY_SURCHARGE_BPS: Record<CurrencyCode, number> = {
  ...DEFAULT_SURCHARGE_BPS,
};

/** Normalises an admin/database value into a usable basis-point rate. */
export function normalizeSurchargeBps(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > MAX_SURCHARGE_BPS) return null;
  return rounded;
}

/** Applies configured rates over the defaults. Unknown/invalid keys ignored. */
export function applySurchargeBps(next: Partial<Record<string, unknown>> | null | undefined) {
  for (const code of CURRENCY_CODES) {
    const value = next ? normalizeSurchargeBps(next[code]) : null;
    CURRENCY_SURCHARGE_BPS[code] = value ?? DEFAULT_SURCHARGE_BPS[code];
  }
}

/** Restores the built-in defaults (used by tests). */
export function resetSurchargeBps() {
  applySurchargeBps(null);
}

/** Current rates as a plain object, safe to send over the wire. */
export function currentSurchargeBps(): Record<CurrencyCode, number> {
  return { ...CURRENCY_SURCHARGE_BPS };
}

export function surchargePercent(currency: CurrencyCode): number {
  return CURRENCY_SURCHARGE_BPS[currency] / 100;
}

/**
 * Base (pre-surcharge) price in minor units. USD is the master amount; other
 * currencies are converted from it at the live daily exchange rate and fall
 * back to the published local price when no fresh rate is loaded.
 */
export function basePriceFor(priceId: string, currency: CurrencyCode): number | null {
  const entry = PACKAGE_PRICES[priceId];
  if (!entry) return null;
  if (currency === DEFAULT_CURRENCY) return entry.amounts[currency];
  const converted = convertFromUsd(entry.amounts[DEFAULT_CURRENCY], currency);
  return converted ?? entry.amounts[currency];
}

/**
 * Final charged amount in minor units: the live local price plus the
 * currency's processing surcharge, rounded up to the nearest minor unit.
 */
export function amountFor(priceId: string, currency: CurrencyCode): number | null {
  const base = basePriceFor(priceId, currency);
  if (base === null) return null;
  const bps = CURRENCY_SURCHARGE_BPS[currency];
  return bps === 0 ? base : Math.ceil((base * (10_000 + bps)) / 10_000);
}

/** The surcharge portion alone, in minor units (0 for USD). */
export function surchargeAmountFor(priceId: string, currency: CurrencyCode): number | null {
  const base = basePriceFor(priceId, currency);
  if (base === null) return null;
  const total = amountFor(priceId, currency);
  if (total === null) return null;
  return total - base;
}


/* ------------------------------------------------- language-aware money -- */

/**
 * Display locale used when a caller doesn't pass one explicitly. The i18n
 * layer keeps this in sync with the visitor's selected language, so symbols,
 * spacing (e.g. "45 €" vs "€45") and digit grouping follow their language
 * while the currency itself stays whatever they chose to pay in.
 */
let displayLocale: string | null = null;

export function setDisplayLocale(locale: string | null) {
  displayLocale = locale;
}

export function getDisplayLocale(): string | null {
  return displayLocale;
}

/**
 * Resolves the BCP-47 tag to format with. We always force Latin digits
 * (`-u-nu-latn`) so an Arabic UI still shows amounts a payment page can be
 * checked against, and fall back to the currency's home locale.
 */
export function moneyLocale(currency: CurrencyCode, locale?: string | null): string {
  const base = locale ?? displayLocale ?? CURRENCIES[currency].locale;
  return base.includes("-u-") ? base : `${base}-u-nu-latn`;
}

export type FormatMoneyOptions = {
  /** Override the display locale (defaults to the active language's locale). */
  locale?: string | null;
  /** Force decimals on/off. Default: hide them for whole amounts. */
  decimals?: boolean;
};

/**
 * Formats a minor-unit amount for display, e.g. "$50", "45,00 €", "₦80 000".
 * Whole amounts drop the decimals; fractional amounts always show exactly two.
 */
export function formatAmount(
  minor: number,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {},
): string {
  const major = minor / 100;
  const whole = Number.isInteger(major);
  const withDecimals = options.decimals ?? !whole;
  const fractionDigits = withDecimals ? 2 : 0;
  try {
    return new Intl.NumberFormat(moneyLocale(currency, options.locale), {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(major);
  } catch {
    // Older engines reject "narrowSymbol" or an odd locale tag.
    const info = CURRENCIES[currency];
    return `${info.symbol}${major.toFixed(fractionDigits)}`;
  }
}

/** Formatted price for a price ID, or null when the ID is unknown. */
export function priceLabel(
  priceId: string,
  currency: CurrencyCode,
  options: FormatMoneyOptions = {},
): string | null {
  const amount = amountFor(priceId, currency);
  if (amount === null) return null;
  return formatAmount(amount, currency, options);
}

