import { useState } from "react";
import { Check } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { SUBSCRIPTION_TIERS, type SubscriptionTierId } from "@/lib/subscription-plans";

const SIGN_IN_REQUIRED = "Please sign in to subscribe.";

type Membership = {
  id: SubscriptionTierId;
  name: string;
  price: string;
  popular?: boolean;
  perks: string[];
};

const MEMBERSHIPS: Membership[] = [
  {
    id: "starter_999",
    name: "Starter Producer",
    price: "$9.99",
    perks: ["YouTube Content ID", "BMG publishing administration", "ISRC/UPC included"],
  },
  {
    id: "pro_1999",
    name: "Pro Producer",
    price: "$19.99",
    popular: true,
    perks: ["YouTube Content ID", "BMG publishing administration", "ISRC/UPC included"],
  },
  {
    id: "label_2999",
    name: "Label & Studio",
    price: "$29.99",
    perks: ["YouTube Content ID", "BMG publishing administration", "ISRC/UPC included"],
  },
];

function featuresFor(membership: Membership): string[] {
  const plan = SUBSCRIPTION_TIERS[membership.id];
  return [
    `${plan.dTokens} D-Tokens`,
    `${plan.hybridTokens} Hybrid Studio Tokens`,
    "Replenished each month",
    ...membership.perks,
  ];
}

/**
 * Producer memberships. The button sends only the tier id.
 * The server maps that id to a Stripe Price.
 */
export function SubscriptionPlans() {
  const [loadingTier, setLoadingTier] = useState<SubscriptionTierId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = loadingTier !== null;

  async function subscribe(tier: SubscriptionTierId) {
    setError(null);
    setLoadingTier(tier);
    let leaving = false;
    try {
      const { data } = await supabase.auth.getSession();
      const userId = data.session?.user?.id ?? "";
      const accessToken = data.session?.access_token?.trim() ?? "";
      if (!userId || userId === "guest_user" || !accessToken) {
        setError(SIGN_IN_REQUIRED);
        return;
      }
      const res = await fetch("/api/stripe/create-checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ tier }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (res.status === 401) {
        setError(SIGN_IN_REQUIRED);
        return;
      }
      if (res.status === 503) {
        setError("Subscriptions are not configured.");
        return;
      }
      if (typeof payload.url === "string" && payload.url) {
        leaving = true;
        window.location.href = payload.url;
        return;
      }
      setError("Could not start checkout.");
    } catch {
      setError("Could not start checkout.");
    } finally {
      if (!leaving) setLoadingTier(null);
    }
  }

  return (
    <section aria-labelledby="producer-memberships-heading" className="mt-8" id="subscription-plans">
      <h2 id="producer-memberships-heading" className="font-display text-3xl font-bold tracking-tight text-white">
        Producer Memberships
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-zinc-400">
        Monthly memberships refill your D-Tokens and Hybrid Studio Tokens. Accepted releases go out to 478+ stores,
        with BMG publishing administration included.
      </p>
      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-3">
        {MEMBERSHIPS.map((membership) => {
          const featured = membership.popular === true;
          return (
            <article
              key={membership.id}
              className={`relative flex flex-col rounded-2xl border bg-zinc-950 p-6 ${
                featured ? "border-red-600 shadow-lg shadow-red-600/20" : "border-zinc-800"
              }`}
            >
              {featured ? (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white">
                  Most Popular
                </span>
              ) : null}
              <h3 className="text-lg font-semibold text-white">{membership.name}</h3>
              <p className="mt-2 text-4xl font-bold text-white">
                {membership.price}
                <span className="text-base font-normal text-zinc-400">/mo</span>
              </p>
              <ul className="mt-6 flex-1 space-y-3">
                {featuresFor(membership).map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-sm text-zinc-300">
                    <Check aria-hidden className="mt-0.5 size-4 flex-none text-red-500" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => void subscribe(membership.id)}
                className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loadingTier === membership.id ? "Redirecting to Stripe..." : `Get ${membership.name}`}
              </button>
            </article>
          );
        })}
      </div>
      {error ? (
        <p id="subscription-checkout-error" role="alert" className="mt-4 text-sm text-amber-300">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export default SubscriptionPlans;
