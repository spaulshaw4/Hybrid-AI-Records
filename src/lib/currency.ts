import { useSyncExternalStore } from "react";
import { fxRatesVersion, subscribeFxRates } from "@/lib/fx";
import { SettingsError } from "@/lib/settings-error";
import {
  CURRENCIES,
  CURRENCY_CODES,
  DEFAULT_CURRENCY,
  currencyForCountry,
  isCurrencyCode,
  type CurrencyCode,
} from "@/lib/pricing";

/**
 * Which currency the visitor is shopping in. Auto-detected from their country
 * on first visit, then remembered — an explicit choice always wins over
 * detection, and the value is SSR-safe (server renders the USD default).
 */

const STORAGE_KEY = "hybrid.currency.v1";
const CHOICE_KEY = "hybrid.currency-chosen.v1";
const COOKIE_KEY = "hybrid_currency";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Mirrors the choice into a cookie so it survives cleared/blocked storage.
 * Returns false when the browser refused to store it.
 */
function writeCookie(code: CurrencyCode | null): boolean {
  if (typeof document === "undefined") return false;
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = code
      ? `${COOKIE_KEY}=${code}; Path=/; Max-Age=${COOKIE_MAX_AGE}; SameSite=Lax${secure}`
      : `${COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
    return code ? readCookie() === code : true;
  } catch {
    /* cookies blocked */
    return false;
  }
}

function readCookie(): CurrencyCode | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${COOKIE_KEY}=`))
    ?.slice(COOKIE_KEY.length + 1);
  return isCurrencyCode(raw ?? null) ? (raw as CurrencyCode) : null;
}

let current: CurrencyCode = DEFAULT_CURRENCY;
let hydrated = false;
let detecting = false;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

function readStorage(): { currency: CurrencyCode; chosen: boolean } {
  if (typeof window === "undefined") return { currency: DEFAULT_CURRENCY, chosen: false };
  const cookie = readCookie();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const stored = isCurrencyCode(raw) ? raw : null;
    return {
      currency: stored ?? cookie ?? DEFAULT_CURRENCY,
      chosen: window.localStorage.getItem(CHOICE_KEY) === "1" || (!stored && cookie !== null),
    };
  } catch {
    return { currency: cookie ?? DEFAULT_CURRENCY, chosen: cookie !== null };
  }
}

/** Asks Cloudflare which country the request came from, then picks a currency. */
async function detectCurrency(): Promise<void> {
  if (detecting) return;
  detecting = true;
  try {
    const response = await fetch("https://www.cloudflare.com/cdn-cgi/trace", {
      cache: "no-store",
    });
    if (!response.ok) return;
    const text = await response.text();
    const country = /(?:^|\n)loc=([A-Z]{2})/.exec(text)?.[1];
    const detected = currencyForCountry(country);
    if (detected !== current) {
      current = detected;
      try {
        window.localStorage.setItem(STORAGE_KEY, detected);
      } catch {
        /* storage blocked — detection still applies for this session */
      }
      emit();
    }
  } catch {
    /* offline or blocked: the stored/default currency stands */
  }
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const { currency, chosen } = readStorage();
  current = currency;
  // Keep other tabs in sync when the visitor switches currency somewhere else.
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    const next = event.newValue;
    if (isCurrencyCode(next) && next !== current) {
      current = next;
      emit();
    }
  });
  // Only auto-detect while the visitor has never picked a currency themselves.
  if (!chosen) void detectCurrency();
}


function subscribe(listener: () => void) {
  hydrate();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => current;
const getServerSnapshot = () => DEFAULT_CURRENCY;

/**
 * Reactive read of the active currency. Also re-renders when live FX rates
 * change, so every displayed price refreshes immediately.
 */
export function useCurrency(): CurrencyCode {
  const code = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useSyncExternalStore(
    subscribeFxRates,
    fxRatesVersion,
    () => 0,
  );
  return code;
}

/**
 * Explicit visitor choice — stops auto-detection from overriding it later.
 *
 * Throws a `SettingsError` when the value isn't a supported currency, or when
 * the browser refused every persistence path (the choice still applies for the
 * current session, but it won't survive a refresh — the caller surfaces that).
 */
export function setCurrency(next: CurrencyCode) {
  if (!isCurrencyCode(next)) {
    throw new SettingsError(`"${String(next)}" is not a supported currency.`);
  }
  if (next === current) return;
  current = next;
  let storedLocally = false;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.localStorage.setItem(CHOICE_KEY, "1");
    storedLocally = window.localStorage.getItem(STORAGE_KEY) === next;
  } catch {
    /* storage blocked — the cookie mirror below still remembers the choice */
  }
  const cookieOk = writeCookie(next);
  emit();
  if (!storedLocally && !cookieOk) {
    throw new SettingsError(
      "Your browser blocked saving this currency, so it will reset when you reload.",
      { applied: true },
    );
  }
}

/**
 * Clears the saved choice and returns to the default, then lets auto-detection
 * run again for this visitor.
 */
export function resetCurrency() {
  current = DEFAULT_CURRENCY;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(CHOICE_KEY);
  } catch {
    /* storage blocked — the reset still applies for this session */
  }
  writeCookie(null);
  emit();
  void detectCurrency();
}

export { CURRENCIES, CURRENCY_CODES };
export type { CurrencyCode };
