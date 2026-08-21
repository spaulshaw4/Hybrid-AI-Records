/**
 * Artist Tokens — $1 each. One token unlocks one permanent download of a
 * track from the Hybrid AI Records catalog. The token counts live here AND are
 * re-read on the server when a purchase is credited, so the browser can never
 * mint tokens.
 */

export type ArtistTokenBundle = {
  priceId: string;
  name: string;
  /** Price in USD cents. */
  amount: number;
  tokens: number;
  highlight?: boolean;
};

export const ARTIST_TOKEN_BUNDLES: ArtistTokenBundle[] = [
  { priceId: "artist_tokens_1", name: "1 Track", amount: 100, tokens: 1 },
  { priceId: "artist_tokens_5", name: "5 Tracks", amount: 500, tokens: 5 },
  { priceId: "artist_tokens_10", name: "10 Tracks", amount: 1000, tokens: 10, highlight: true },
  { priceId: "artist_tokens_25", name: "25 Tracks", amount: 2500, tokens: 25 },
];

export function artistBundleFor(priceId: string): ArtistTokenBundle | undefined {
  return ARTIST_TOKEN_BUNDLES.find((bundle) => bundle.priceId === priceId);
}

export function artistUsdLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

/** Query-string flag the catalog uses to credit a purchase on return. */
export const ARTIST_TOKEN_RETURN_PARAM = "artist_token_session";
