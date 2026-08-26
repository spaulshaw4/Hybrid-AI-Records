/**
 * Hybrid Token bundles. The token counts live here AND are re-read on the
 * server when a purchase is credited, so the browser can never mint tokens.
 */

export type TokenBundle = {
  priceId: string;
  name: string;
  /** Price in USD cents. */
  amount: number;
  tokens: number;
  bonus: number;
  highlight?: boolean;
};

export const TOKEN_BUNDLES: TokenBundle[] = [
  {
    priceId: "tokens_single",
    name: "Single Token",
    amount: 200,
    tokens: 1,
    bonus: 0,
  },
  {
    priceId: "tokens_starter_pack",
    name: "Starter Pack",
    amount: 1000,
    tokens: 5,
    bonus: 0,
  },
  {
    priceId: "tokens_pro_pack",
    name: "Pro Pack",
    amount: 2500,
    /** 12 paid + 2 bonus — `tokens` is the total credited on purchase. */
    tokens: 14,
    bonus: 2,
    highlight: true,
  },
  {
    priceId: "tokens_studio_pack",
    name: "Studio Pack",
    amount: 5000,
    /** 25 paid + 5 bonus — `tokens` is the total credited on purchase. */
    tokens: 30,
    bonus: 5,
  },
];

export function bundleFor(priceId: string): TokenBundle | undefined {
  return TOKEN_BUNDLES.find((bundle) => bundle.priceId === priceId);
}

export function usdLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function perTokenLabel(bundle: TokenBundle): string {
  return `$${(bundle.amount / 100 / bundle.tokens).toFixed(2)}/ea`;
}
