import { useState } from "react";
import { Check } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { PAIR_TOPUPS, type PairTopupId } from "@/lib/pair-topups";
import { type SingleTokenType } from "@/lib/single-tokens";
import { SUBSCRIPTION_TIERS, type SubscriptionTierId } from "@/lib/subscription-plans";
import { cn } from "@/lib/utils";

const SIGN_IN_REQUIRED = "Please sign in to subscribe.";
const PACK_SIGN_IN = "Please sign in to buy tokens.";
const PACKS_NOT_CONFIGURED = "Token packs are not configured.";
const SINGLE_NOT_CONFIGURED = "Token checkout is not configured.";
const ARTIST_QTY_MIN = 1;
const ARTIST_QTY_MAX = 100;
const HYBRID_TOKEN_USD = 2;
const ARTIST_TOKEN_USD = 1;
const ARTIST_PRESETS = [1, 5, 10, 20] as const;

const GLASS_CARD =
  "relative flex min-w-0 flex-col rounded-2xl p-6 bg-zinc-900/30 backdrop-blur-xl border shadow-[0_8px_32px_0_rgba(0,0,0,0.4)] transition-all";

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
 * unbundled studio, distribution, and artist-support tokens.
 * Artist support on this page posts tokenType artist_token and quantity.
 * It does not buy Hybrid Tokens. Requests never carry a Stripe price id.
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

  async function buySingle(tokenType: SingleTokenType, quantity: number, pendingKey: string = tokenType) {
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
          {`Buy a studio run at $${HYBRID_TOKEN_USD.toFixed(2)} per Hybrid Token, a Too Lost distribution pass at $1.00 per D-Token, or Artist Tokens for direct support at $${ARTIST_TOKEN_USD.toFixed(2)} each.`}
        </p>
        {/* Page already pads horizontally; extra px-4 here would double-pad. */}
        <div className="relative mx-auto mt-8 w-full max-w-6xl overflow-visible py-12">
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/4 left-10 h-72 w-72 rounded-full bg-red-600/20 blur-[100px]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-1/4 right-10 h-80 w-80 rounded-full bg-blue-600/20 blur-[120px]"
          />
          <div className="relative z-10 grid grid-cols-1 gap-6 md:grid-cols-3">
            <article className={cn(GLASS_CARD, "border-white/10 hover:border-white/20")}>
              <h3 className="min-w-0 text-balance text-lg font-semibold leading-snug text-white">
                Engine 2.0 (Studio Run)
              </h3>
              <p className="mt-2 text-4xl font-bold text-white">
                {`$${HYBRID_TOKEN_USD.toFixed(2)}`}
                <span className="text-base font-normal text-zinc-400"> / Hybrid Token</span>
              </p>
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

            <article className={cn(GLASS_CARD, "border-white/10 hover:border-white/20")}>
              <h3 className="min-w-0 text-balance text-lg font-semibold leading-snug text-white">
                Too Lost DSP Distribution
              </h3>
              <p className="mt-2 text-4xl font-bold text-white">
                $1.00
                <span className="text-base font-normal text-zinc-400"> / D-Token</span>
              </p>
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

            <article className={cn(GLASS_CARD, "overflow-hidden border-blue-500/30 hover:border-white/20")}>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-blue-500 to-indigo-500"
              />
              <h3 className="min-w-0 text-balance text-lg font-semibold leading-snug text-white">
                Artist Tokens (Direct Support)
              </h3>
              <p className="mt-2 text-4xl font-bold text-white">
                {`$${ARTIST_TOKEN_USD.toFixed(2)}`}
                <span className="text-base font-normal text-zinc-400"> / token</span>
              </p>
              <p className="mt-2 text-sm text-zinc-300">
                Direct artist patronage. 1 Token unlocks an uncompressed 24-bit broadcast master download and sends
                $1.00 directly to support the creator.
              </p>
              <div
                className="mt-4 inline-flex items-center overflow-hidden rounded-md border border-white/10 bg-black/20"
                role="group"
                aria-label="Artist Token quantity"
              >
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  disabled={busy || artistQty <= ARTIST_QTY_MIN}
                  onClick={() => setArtistQuantity(artistQty - 1)}
                  className="px-3 py-2 text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  −
                </button>
                <span className="min-w-10 border-x border-white/10 px-3 py-2 text-center font-mono text-sm text-white">
                  {artistQty}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  disabled={busy || artistQty >= ARTIST_QTY_MAX}
                  onClick={() => setArtistQuantity(artistQty + 1)}
                  className="px-3 py-2 text-white hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  +
                </button>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {ARTIST_PRESETS.map((qty) => (
                  <button
                    key={qty}
                    type="button"
                    disabled={busy}
                    aria-pressed={artistQty === qty}
                    onClick={() => setArtistQuantity(qty)}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60",
                      artistQty === qty
                        ? "border-blue-500 bg-blue-500/20 text-blue-200 shadow-[0_0_12px_rgba(59,130,246,0.45)]"
                        : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:bg-white/10",
                    )}
                  >
                    {`$${qty * ARTIST_TOKEN_USD}`}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={busy}
                aria-live="polite"
                onClick={() => void buySingle("artist_token", artistQty, "artist_support")}
                className="mt-6 inline-flex w-full items-center justify-center rounded-md bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:from-blue-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {pending === "artist_support"
                  ? "Redirecting to Stripe..."
                  : `Support Artist • $${(artistQty * ARTIST_TOKEN_USD).toFixed(2)}`}
              </button>
            </article>
          </div>
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
