/**
 * Live foreign-exchange layer.
 *
 * USD is the master price ($25 Foundation / $100 Visual Push / $150 Full Hybrid …). Every other currency is
 * derived from the USD amount using the most recent rate we fetched, then
 * rounded up to a tidy increment so the storefront never shows something like
 * "R 913,47". Rates refresh once a day (see
 * `src/routes/api/public/hooks/refresh-fx.ts`).
 *
 * If a rate is missing, stale or implausible we silently fall back to the
 * published local prices in `@/lib/pricing` — pricing must never break because
 * an exchange-rate provider had a bad morning.
 */

import type { CurrencyCode } from "@/lib/pricing";

export type FxRate = {
  /** How many units of this currency one US dollar buys. */
  rate: number;
  /** ISO timestamp of the provider quote we stored. */
  fetchedAt: string;
  source: string;
};

export type FxRateMap = Partial<Record<CurrencyCode, FxRate>>;

/** A quote older than this is treated as missing (the daily job has failed). */
export const FX_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Sanity bounds per currency. A provider glitch (or a wrong base currency)
 * can't move our prices outside these — we fall back to published prices.
 */
export const FX_PLAUSIBLE_RANGE: Record<CurrencyCode, [number, number]> = {
  usd: [1, 1],
  eur: [0.5, 2],
  gbp: [0.4, 2],
  ngn: [200, 20_000],
  zar: [5, 60],
};

/**
 * Rounding step, in minor units, applied to a converted price. Keeps the
 * published number human: whole euros/pounds, tens of rand, thousands of naira.
 */
export const FX_ROUNDING_STEP: Record<CurrencyCode, number> = {
  usd: 1,
  eur: 100,
  gbp: 100,
  ngn: 100_000,
  zar: 1_000,
};

/** Kept local so this module never imports back into the pricing table. */
const CURRENCY_CODES: CurrencyCode[] = ["usd", "eur", "gbp", "ngn", "zar"];

/** Live rates, replaced at boot (browser) and per request (server). */
const RATES: FxRateMap = {};

export function isPlausibleRate(currency: CurrencyCode, rate: unknown): rate is number {
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return false;
  const [min, max] = FX_PLAUSIBLE_RANGE[currency];
  return rate >= min && rate <= max;
}

function isFresh(fetchedAt: string, now: number): boolean {
  const t = Date.parse(fetchedAt);
  return Number.isFinite(t) && now - t <= FX_MAX_AGE_MS;
}

/**
 * Bumped whenever the rate table changes, so UI that renders prices can
 * re-render the instant fresh rates arrive instead of waiting for a reload.
 */
let fxVersion = 0;
const fxListeners = new Set<() => void>();

export function subscribeFxRates(listener: () => void) {
  fxListeners.add(listener);
  return () => fxListeners.delete(listener);
}

export function fxRatesVersion() {
  return fxVersion;
}

/** Replaces the in-memory rate table. Invalid or stale entries are dropped. */
export function applyFxRates(next: FxRateMap | null | undefined, now = Date.now()) {
  for (const code of CURRENCY_CODES) delete RATES[code];
  if (next) {
    for (const code of CURRENCY_CODES) {
      const entry = next[code];
      if (!entry || !isPlausibleRate(code, entry.rate) || !isFresh(entry.fetchedAt, now)) continue;
      RATES[code] = { rate: entry.rate, fetchedAt: entry.fetchedAt, source: entry.source };
    }
  }
  fxVersion += 1;
  fxListeners.forEach((l) => l());
}

/** Clears every rate (used by tests and as the offline fallback). */
export function resetFxRates() {
  applyFxRates(null);
}

/** Current usable rates, safe to send over the wire. */
export function currentFxRates(): FxRateMap {
  return { ...RATES };
}

export function fxRateFor(currency: CurrencyCode): FxRate | null {
  return RATES[currency] ?? null;
}

/**
 * Converts a USD amount in cents into `currency`'s minor units at the live
 * rate, rounded up to that currency's tidy increment. Returns null when no
 * usable rate is loaded, so the caller keeps its published price.
 */
export function convertFromUsd(usdMinor: number, currency: CurrencyCode): number | null {
  if (currency === "usd") return usdMinor;
  const entry = RATES[currency];
  if (!entry) return null;
  const step = FX_ROUNDING_STEP[currency];
  const raw = (usdMinor / 100) * entry.rate * 100; // minor units of the target
  return Math.ceil(raw / step) * step;
}
