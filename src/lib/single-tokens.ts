/**
 * Unbundled one-time tokens on Plans & Tokens.
 * Stripe Price ids live in env, not in the browser.
 * Distinct from pair5/pair10/pair25, d5/d10/d25, and the catalog
 * Artist Support Token (metadata.type === "artist_token", inline price_data).
 */

export const SINGLE_TOKEN_PRODUCTS = {
  h_token: { priceEnv: "STRIPE_PRICE_H_TOKEN" },
  d_token: { priceEnv: "STRIPE_PRICE_D_TOKEN" },
  artist_token: { priceEnv: "STRIPE_PRICE_ARTIST_TOKEN" },
} as const;

export type SingleTokenType = keyof typeof SINGLE_TOKEN_PRODUCTS;

export const SINGLE_TOKEN_MIN = 1;
export const SINGLE_TOKEN_MAX = 100;

export function isSingleTokenType(value: unknown): value is SingleTokenType {
  return value === "h_token" || value === "d_token" || value === "artist_token";
}

/** Integer quantity 1–100. Accepts a JSON number or a Stripe metadata string. */
export function parseSingleTokenQuantity(raw: unknown): number | null {
  let value: number | null = null;
  if (typeof raw === "number" && Number.isInteger(raw)) value = raw;
  else if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) {
    const parsed = Number(raw.trim());
    if (Number.isSafeInteger(parsed)) value = parsed;
  }
  if (value == null || value < SINGLE_TOKEN_MIN || value > SINGLE_TOKEN_MAX) return null;
  return value;
}

/** Ledger label stored with the credit. Not a browser-supplied Stripe Price id. */
export function singleTokenLedgerPriceId(tokenType: SingleTokenType): string {
  if (tokenType === "h_token") return "single_h_token";
  if (tokenType === "d_token") return "single_d_token";
  return "single_artist_token";
}
