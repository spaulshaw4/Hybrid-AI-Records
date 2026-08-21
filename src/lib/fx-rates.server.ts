import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { applyFxRates, currentFxRates, isPlausibleRate, type FxRateMap } from "@/lib/fx";
import { CURRENCY_CODES, type CurrencyCode } from "@/lib/pricing";

/** Short cache so a checkout burst doesn't hit the database per line item. */
const CACHE_MS = 30_000;

type Cached = { rates: FxRateMap; at: number };
let cache: Cached | null = null;

function publicClient() {
  return createClient<Database>(
    process.env["SUPABASE_URL"]!,
    process.env["SUPABASE_PUBLISHABLE_KEY"]!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

/**
 * Loads the latest daily exchange rates and applies them to the shared FX
 * table, so every pricing helper quotes live-converted local prices. Any
 * failure falls back to the published local prices — checkout must never stall
 * on a rate read.
 */
export async function readFxRates(): Promise<FxRateMap> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    applyFxRates(cache.rates);
    return cache.rates;
  }

  try {
    const { data, error } = await publicClient()
      .from("fx_rates")
      .select("currency, rate, source, fetched_at");
    if (error) throw new Error(error.message);

    const next: FxRateMap = {};
    for (const row of data ?? []) {
      const code = String(row.currency) as CurrencyCode;
      if (!CURRENCY_CODES.includes(code)) continue;
      const rate = Number(row.rate);
      if (!isPlausibleRate(code, rate)) continue;
      next[code] = {
        rate,
        fetchedAt: String(row.fetched_at),
        source: String(row.source ?? "unknown"),
      };
    }

    applyFxRates(next);
    const rates = currentFxRates();
    cache = { rates, at: Date.now() };
    return rates;
  } catch (err) {
    console.error("FX rate read failed:", (err as Error).message);
    applyFxRates(null);
    return {};
  }
}

/** Drops the memo so the next read hits the database (used after a refresh). */
export function invalidateFxCache() {
  cache = null;
}
