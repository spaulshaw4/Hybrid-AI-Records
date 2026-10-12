import { useState } from "react";
import { Check } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { PAIR_TOPUPS, type PairTopupId } from "@/lib/pair-topups";
import { type SingleTokenType } from "@/lib/single-tokens";
import { SUBSCRIPTION_TIERS, type SubscriptionTierId } from "@/lib/subscription-plans";

const SIGN_IN_REQUIRED = "Please sign in to subscribe.";
const PACK_SIGN_IN = "Please sign in to buy tokens.";
const PACKS_NOT_CONFIGURED = "Token packs are not configured.";
const SINGLE_NOT_CONFIGURED = "Token checkout is not configured.";
const ARTIST_QTY_MIN = 1;
const ARTIST_QTY_MAX = 100;

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
    `${plan.hybridTokens} Hybrid Tokens (Studio Runs)`,
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
 * Monthly producer memberships, one-time Hybrid + D-Token pairs, and
 * unbundled studio and distribution tokens. Artist support on this page
 * buys Hybrid Tokens (h_token). Requests never carry a Stripe price id.
 */
export function PlansTokensView() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [artistQty, setArtistQty] = useState(1);
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

  async function buySingle(tokenType: SingleTokenType, quantity: number, pendingKey = tokenType) {
    setError(null);
    setPending(pendingKey);
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
        body: JSON.stringify({ tokenType, quantity }),
      });
      const payload = (await res.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
      if (res.status === 401) {
        setError(PACK_SIGN_IN);
        return;
      }
      if (res.status === 503) {
        setError(
          typeof payload.error === "string" && payload.error.trim() ? payload.error : SINGLE_NOT_CONFIGURED,
        );
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

  function setArtistQuantity(next: number) {
    setArtistQty(Math.min(ARTIST_QTY_MAX, Math.max(ARTIST_QTY_MIN, next)));
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
                {pack.hybridTokens} Hybrid Tokens + {pack.dTokens} D-Tokens
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

      <section aria-labelledby="individual-tokens-passes" className="mt-12 border-t border-zinc-800 pt-10">
        <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-400">Standalone</p>
        <h2 id="individual-tokens-passes" className="mt-2 font-display text-3xl font-bold tracking-tight text-white">
          Individual Tokens & Passes
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-zinc-400">
          Buy a single studio run, a single distribution pass, or Hybrid Tokens for artist support and track unlocks at $1.00 each.
        </p>
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          <article className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 px-6 py-6">
            <h3 className="text-lg font-semibold text-white">Single Hybrid Token (Studio Run) — $1.00</h3>
            <p className="mt-2 text-4xl font-bold text-white">$1.00</p>
            <p className="mt-2 flex-1 text-sm text-zinc-300">1 studio generation run for master track rendering.</p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void buySingle("h_token", 1)}
              className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending === "h_token" ? "Redirecting to Stripe..." : "Buy Single Hybrid Token"}
            </button>
          </article>

          <article className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 px-6 py-6">
            <h3 className="text-lg font-semibold text-white">Single D-Token (Too Lost Distribution) — $1.00</h3>
            <p className="mt-2 text-4xl font-bold text-white">$1.00</p>
            <p className="mt-2 flex-1 text-sm text-zinc-300">
              1 standalone track release pass to global DSPs (Spotify, Apple Music) via Too Lost infrastructure.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void buySingle("d_token", 1)}
              className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending === "d_token" ? "Redirecting to Stripe..." : "Buy Single D-Token"}
            </button>
          </article>

          <article className="flex flex-col rounded-2xl border border-zinc-800 bg-zinc-950 px-6 py-6">
            <h3 className="text-lg font-semibold text-white">Artist Support & Track Unlocks — $1.00</h3>
            <p className="mt-2 text-4xl font-bold text-white">$1.00</p>
            <p className="mt-2 text-sm text-zinc-300">
              Artist support and catalog track unlocks spend Hybrid Tokens. This buys Hybrid Tokens for that balance at
              $1.00 each.
            </p>
            <div
              className="mt-4 inline-flex items-center overflow-hidden rounded-md border border-zinc-700 bg-zinc-900"
              role="group"
              aria-label="Hybrid Token quantity"
            >
              <button
                type="button"
                aria-label="Decrease quantity"
                disabled={busy || artistQty <= ARTIST_QTY_MIN}
                onClick={() => setArtistQuantity(artistQty - 1)}
                className="px-3 py-2 text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                −
              </button>
              <span className="min-w-10 border-x border-zinc-700 px-3 py-2 text-center font-mono text-sm text-white">
                {artistQty}
              </span>
              <button
                type="button"
                aria-label="Increase quantity"
                disabled={busy || artistQty >= ARTIST_QTY_MAX}
                onClick={() => setArtistQuantity(artistQty + 1)}
                className="px-3 py-2 text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                +
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              {([1, 5, 10] as const).map((qty) => (
                <button
                  key={qty}
                  type="button"
                  disabled={busy}
                  aria-pressed={artistQty === qty}
                  onClick={() => setArtistQuantity(qty)}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                    artistQty === qty
                      ? "border-red-600 bg-red-600 text-white"
                      : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800"
                  }`}
                >
                  ${qty}
                </button>
              ))}
            </div>
            <p className="mt-3 text-sm font-semibold text-white" aria-live="polite">
              {`Total $${artistQty.toFixed(2)}`}
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() => void buySingle("h_token", artistQty, "hybrid_support")}
              className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending === "hybrid_support" ? "Redirecting to Stripe..." : "Buy Hybrid Tokens"}
            </button>
          </article>
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
