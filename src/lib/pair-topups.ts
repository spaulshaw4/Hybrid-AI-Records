/**
 * One-time Hybrid + D-Token pairs. Distinct from d5/d10/d25 (D-token refill)
 * and from subscription tiers. Stripe Price ids live in env, not in the client.
 */
export const PAIR_TOPUPS = {
  pair5: {
    hybridTokens: 5,
    dTokens: 5,
    amountCents: 1000,
    priceLabel: "$10.00",
    name: "5 Token Pack",
    priceEnv: "STRIPE_PRICE_PAIR_5",
  },
  pair10: {
    hybridTokens: 10,
    dTokens: 10,
    amountCents: 2000,
    priceLabel: "$20.00",
    name: "10 Token Pack",
    priceEnv: "STRIPE_PRICE_PAIR_10",
  },
  pair25: {
    hybridTokens: 25,
    dTokens: 25,
    amountCents: 5000,
    priceLabel: "$50.00",
    name: "25 Token Pack",
    priceEnv: "STRIPE_PRICE_PAIR_25",
  },
} as const;

export type PairTopupId = keyof typeof PAIR_TOPUPS;

export function isPairTopup(value: unknown): value is PairTopupId {
  return value === "pair5" || value === "pair10" || value === "pair25";
}
