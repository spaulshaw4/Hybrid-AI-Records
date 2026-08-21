/**
 * V Tokens power the V Engine (cinematic video renders).
 *
 * One V Token = $12.50 = 60 seconds (1 minute) of rendered video. Billing
 * always rounds up to the next whole minute, so a 3:30 track (210s) costs
 * 4 tokens ($50.00). Bundle sizes are re-read on the server when a purchase
 * is credited, so the browser can never mint them.
 */

export type VTokenBundle = {
  priceId: string;
  name: string;
  /** Price in USD cents. */
  amount: number;
  tokens: number;
  bonus: number;
  highlight?: boolean;
};

/** Seconds of V Engine render time covered by one V Token. */
export const V_TOKEN_SECONDS = 60;
/** List price of a single V Token, in USD cents ($12.50). */
export const V_TOKEN_PRICE_CENTS = 1250;

export const V_TOKEN_BUNDLES: VTokenBundle[] = [
  {
    priceId: "v_tokens_single",
    name: "Single V Token",
    amount: 1250,
    tokens: 1,
    bonus: 0,
  },
  {
    priceId: "v_tokens_trio",
    name: "Short Film Pack",
    amount: 5000,
    tokens: 4,
    bonus: 0,
  },
  {
    priceId: "v_tokens_reel",
    name: "Reel Pack",
    amount: 9600,
    tokens: 8,
    bonus: 0,
    highlight: true,
  },
  {
    priceId: "v_tokens_feature",
    name: "Feature Pack",
    amount: 22500,
    tokens: 18,
    bonus: 2,
  },
];


export function vBundleFor(priceId: string): VTokenBundle | undefined {
  return V_TOKEN_BUNDLES.find((bundle) => bundle.priceId === priceId);
}

/** V Tokens needed to render a video of `seconds` length. */
export function vTokensForDuration(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / V_TOKEN_SECONDS));
}

export function vUsdLabel(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export function vPerTokenLabel(bundle: VTokenBundle): string {
  return `$${(bundle.amount / 100 / bundle.tokens).toFixed(2)}/ea`;
}

/** "1 min", "8 min" — render time a bundle unlocks. */
export function vRuntimeLabel(tokens: number): string {
  const minutes = (tokens * V_TOKEN_SECONDS) / 60;
  return `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} min of render`;
}


/** Shortest render the V Engine accepts, in seconds. */
export const V_MIN_DURATION = 30;
/** Longest render the V Engine accepts, in seconds (14 minutes = 4 V Tokens). */
export const V_MAX_DURATION = 840;
/** Slider granularity, in seconds. */
export const V_DURATION_STEP = 30;

export type VRenderQuote = {
  /** Duration actually charged for, after clamping/snapping. */
  seconds: number;
  tokens: number;
  cents: number;
};

/**
 * Canonical V Token cost rule. The server re-runs this on every spend, so a
 * tampered client duration or token count can never lower the charge.
 */
export function quoteVRender(seconds: unknown): VRenderQuote {
  const raw = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : V_MIN_DURATION;
  const snapped = Math.ceil(raw / V_DURATION_STEP) * V_DURATION_STEP;
  const clamped = Math.min(V_MAX_DURATION, Math.max(V_MIN_DURATION, snapped));
  const tokens = vTokensForDuration(clamped);
  return { seconds: clamped, tokens, cents: tokens * V_TOKEN_PRICE_CENTS };
}
