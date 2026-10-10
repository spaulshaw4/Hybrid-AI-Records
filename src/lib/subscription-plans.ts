/** Server-owned monthly plans. Prices come from Stripe Price env vars, never the browser. */

export const SUBSCRIPTION_TIERS = {
  starter_999: {
    name: "Starter",
    priceLabel: "$9.99/mo",
    dTokens: 5,
    hybridTokens: 20,
    priceEnv: "STRIPE_PRICE_STARTER",
  },
  pro_1999: {
    name: "Pro",
    priceLabel: "$19.99/mo",
    dTokens: 12,
    hybridTokens: 50,
    priceEnv: "STRIPE_PRICE_PRO",
  },
  label_2999: {
    name: "Label",
    priceLabel: "$29.99/mo",
    dTokens: 25,
    hybridTokens: 120,
    priceEnv: "STRIPE_PRICE_LABEL",
  },
} as const;

export type SubscriptionTierId = keyof typeof SUBSCRIPTION_TIERS;
export type SubscriptionPlanName = "Starter" | "Pro" | "Label" | "Free";

export function isSubscriptionTier(value: unknown): value is SubscriptionTierId {
  return value === "starter_999" || value === "pro_1999" || value === "label_2999";
}

/** Active paid tier only. Canceled, missing, or unknown plans read as Free. */
export function planName(tier: unknown, status: unknown): SubscriptionPlanName {
  if (status !== "active" || !isSubscriptionTier(tier)) return "Free";
  return SUBSCRIPTION_TIERS[tier].name;
}
