import { useState } from "react";
import { Check } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { PAIR_TOPUPS, type PairTopupId } from "@/lib/pair-topups";
import { SUBSCRIPTION_TIERS, type SubscriptionTierId } from "@/lib/subscription-plans";

const SIGN_IN_REQUIRED = "Please sign in to subscribe.";
const PACK_SIGN_IN = "Please sign in to buy tokens.";
const PACKS_NOT_CONFIGURED = "Token packs are not configured.";

type Membership = {
  id: SubscriptionTierId;
  name: string;
  price: string;
  description: string;
  popular?: boolean;
  button: string;
  perks: string[];
};

const MEMBERSHIPS: Membership[] = [
  {
    id: "starter_999",
    name: "Starter Producer",
    price: "$9.99",
    description: "1 complete 10-track album per month.",
    button: "SELECT STARTER",
    perks: ["Deploy 1 Full 10-Track Album", "BMG Global Publishing Admin"],
  },
  {
    id: "pro_1999",
    name: "Pro Producer",
    price: "$19.99",
    description: "1 album + 5 bonus singles / EP drops.",
    popular: true,
    button: "SELECT PRO",
    perks: ["1 Album + 5-Track EP Capacity", "Up to 3 Artist Aliases", "BMG Global Publishing Admin"],
  },
  {
    id: "label_2999",
    name: "Label & Studio",
    price: "$29.99",
    description: "2 complete albums per month for catalogs.",
    button: "SELECT LABEL",
    perks: ["Deploy 2 Full 10-Track Albums", "Unlimited Artist Aliases", "Priority BMG Registration Queue"],
  },
];

const PACKS = (Object.keys(PAIR_TOPUPS) as PairTopupId[]).map((id) => ({
  id,
  ...PAIR_TOPUPS[id],
}));

function allowanceLines(membership: Membership): string[] {
  const plan = SUBSCRIPTION_TIERS[membership.id];
  return [
    `${plan.hybridTokens} H-Tokens (Studio Runs)`,
    `${plan.dTokens} D-Tokens (Too Lost Stores)`,
    ...membership.perks,
  ];
}

async function sessionToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? "";
  const accessToken = data.session?.access_token?.trim() ?? "";
  if (!userId || userId === "guest_user" || !accessToken) return null;
  return accessToken;
}

/**
 * Monthly producer memberships and one-time Hybrid + D-Token pairs.
 * Membership posts `{ tier }` to the subscription checkout. Packs post `{ tier }`
 * to the billing checkout. Neither request carries a Stripe price id.
 */
export function PlansTokensView() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  async function subscribe(tier: SubscriptionTierId) {
    setError(null);
    setPending(tier);
    let leaving = false;
    try {
      const accessToken = await sessionToken();
      if (!accessToken) {
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
      if (!leaving) setPending(null);
    }
  }

  async function buyPack(tier: PairTopupId) {
    setError(null);
    setPending(tier);
    let leaving = false;
    try {
      const accessToken = await sessionToken();
      if (!accessToken) {
        setError(PACK_SIGN_IN);
        return;
      }
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ tier }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (res.status === 401) {
        setError(PACK_SIGN_IN);
        return;
      }
      if (res.status === 503) {
        setError(PACKS_NOT_CONFIGURED);
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
      if (!leaving) setPending(null);
    }
  }

  return (
    <div className="mt-8">
      <section aria-labelledby="monthly-producer-plans">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">Recurring Membership</p>
        <h2 id="monthly-producer-plans" className="mt-2 font-display text-3xl font-bold tracking-tight text-white">
          Monthly Producer Plans
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Every plan includes 1:1 Hybrid Studio generation tokens and Too Lost distribution D-Tokens.
        </p>
        <div className="mt-8 grid grid-cols-1 items-stretch gap-6 overflow-visible pt-4 md:grid-cols-3">
          {MEMBERSHIPS.map((membership) => {
            const featured = membership.popular === true;
            return (
              <article
                key={membership.id}
                className={`relative flex flex-col rounded-2xl border bg-zinc-950 px-6 pb-6 ${
                  featured ? "border-red-600 pt-8 shadow-lg shadow-red-600/20" : "border-zinc-800 pt-6"
                }`}
              >
                {featured ? (
                  <span className="absolute -top-3.5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-red-600 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                    Most Popular
                  </span>
                ) : null}
                <h3 className={`text-lg font-semibold text-white ${featured ? "mt-2" : ""}`}>{membership.name}</h3>
                <p className="mt-2 text-4xl font-bold text-white">
                  {membership.price}
                  <span className="text-base font-normal text-zinc-400"> / month</span>
                </p>
                <p className="mt-2 text-sm text-zinc-400">{membership.description}</p>
                <ul className="mt-6 flex-1 space-y-3">
                  {allowanceLines(membership).map((feature) => (
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
                  className={`mt-6 inline-flex w-full items-center justify-center rounded-md px-4 py-3 text-sm font-semibold uppercase tracking-wide text-white transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    featured ? "bg-red-600 hover:bg-red-500" : "border border-zinc-700 bg-zinc-900 hover:bg-zinc-800"
                  }`}
                >
                  {pending === membership.id ? "Redirecting to Stripe..." : membership.button}
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="instant-token-topups" className="mt-12 border-t border-zinc-800 pt-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">On-Demand Add-Ons</p>
        <h2 id="instant-token-topups" className="mt-2 font-display text-3xl font-bold tracking-tight text-white">
          Instant Token Top-Ups
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Need extra runs without changing your plan? Top up instantly at $2.00 per token pair (1 Hybrid Studio + 1
          Too Lost D-Token).
        </p>
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          {PACKS.map((pack) => (
            <article key={pack.id} className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 px-6 py-6">
              <h3 className="text-lg font-semibold text-white">{pack.name}</h3>
              <p className="mt-2 text-sm text-zinc-300">
                {pack.hybridTokens} H-Tokens + {pack.dTokens} D-Tokens
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void buyPack(pack.id)}
                className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending === pack.id ? "Redirecting to Stripe..." : pack.priceLabel}
              </button>
            </article>
          ))}
        </div>
      </section>

      {error ? (
        <p id="plans-checkout-error" role="alert" className="mt-4 text-sm text-amber-300">
          {error}
        </p>
      ) : null}
    </div>
  );
}
