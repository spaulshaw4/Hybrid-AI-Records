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
const QTY_MIN = 1;
const QTY_MAX = 100;
const HYBRID_TOKEN_USD = 2;
const D_TOKEN_USD = 1;
const ARTIST_TOKEN_USD = 1;
const ENGINE_PRESETS = [1, 3, 5, 10] as const;
const DISTRIBUTION_PRESETS = [1, 5, 10, 20] as const;
const ARTIST_PRESETS = [1, 5, 10, 20] as const;

const GLASS_CARD =
  "rounded-2xl p-6 bg-zinc-900/30 backdrop-blur-xl border border-white/10 shadow-[0_8px_32px_0_rgba(0,0,0,0.37)] hover:border-white/20 transition-all";

const PRESET_SELECTED =
  "bg-red-600 text-white border-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]";

const RED_BUY =
  "mt-6 inline-flex w-full items-center justify-center rounded-md bg-red-600 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60";

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

function clampQty(next: number): number {
  if (!Number.isFinite(next)) return QTY_MIN;
  return Math.min(QTY_MAX, Math.max(QTY_MIN, Math.trunc(next)));
}

function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

async function sessionToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user?.id ?? "";
  const accessToken = data.session?.access_token?.trim() ?? "";
  if (!userId || userId === "guest_user" || !accessToken) return null;
  return accessToken;
}

function QuantityControl({
  label,
  noun,
  quantity,
  disabled,
  onChange,
}: {
  label: string;
  noun: string;
  quantity: number;
  disabled: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div
      className="mt-4 flex w-full items-center overflow-hidden rounded-md border border-white/10 bg-black/20"
      role="group"
      aria-label={label}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        disabled={disabled || quantity <= QTY_MIN}
        onClick={() => onChange(quantity - 1)}
        className="shrink-0 px-3 py-2 text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        −
      </button>
      <span className="flex-1 text-center font-mono text-sm font-bold text-white">{`${quantity} ${noun}`}</span>
      <button
        type="button"
        aria-label="Increase quantity"
        disabled={disabled || quantity >= QTY_MAX}
        onClick={() => onChange(quantity + 1)}
        className="shrink-0 px-3 py-2 text-white hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

function QuantityPresets({
  presets,
  quantity,
  disabled,
  labelFor,
  onSelect,
}: {
  presets: readonly number[];
  quantity: number;
  disabled: boolean;
  labelFor: (qty: number) => string;
  onSelect: (qty: number) => void;
}) {
  return (
    <div className="mt-3 grid grid-cols-4 gap-2">
      {presets.map((qty) => {
        const selected = quantity === qty;
        return (
          <button
            key={qty}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onSelect(qty)}
            className={cn(
              "rounded-md border px-2 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60",
              selected
                ? PRESET_SELECTED
                : "border-white/10 bg-white/5 text-zinc-300 hover:border-white/20 hover:bg-white/10",
            )}
          >
            {labelFor(qty)}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Monthly producer memberships, one-time Hybrid + D-Token pairs, and
 * unbundled studio runs, distribution passes, and artist tokens.
 * Standalone checkout posts tokenType and quantity only.
 * Requests never carry a Stripe price id or userId.
 */
export function PlansTokensView() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engineQty, setEngineQty] = useState(1);
  const [distributionQty, setDistributionQty] = useState(1);
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

  async function buySingle(tokenType: SingleTokenType, quantity: number) {
    setError(null);
    setPending(tokenType);
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

  function setTokenQty(tokenType: SingleTokenType, next: number) {
    const value = clampQty(next);
    if (tokenType === "h_token") setEngineQty(value);
    else if (tokenType === "d_token") setDistributionQty(value);
    else setArtistQty(value);
  }

  const standalone = [
    {
      tokenType: "h_token" as const,
      title: "Engine 2.0 (Studio Run)",
      amount: usd(HYBRID_TOKEN_USD),
      per: " / Hybrid",
      copy: "1 studio generation run for master track rendering.",
      qty: engineQty,
      noun: "Runs",
      control: "engine runs",
      presets: ENGINE_PRESETS,
      presetLabel: (qty: number) => String(qty),
      buy: (qty: number) => `Buy Engine Runs • ${usd(qty * HYBRID_TOKEN_USD)}`,
    },
    {
      tokenType: "d_token" as const,
      title: "Too Lost DSP Distribution",
      amount: usd(D_TOKEN_USD),
      per: " / D-Token",
      copy: "1 standalone track release pass to global DSPs (Spotify, Apple Music) via Too Lost infrastructure.",
      qty: distributionQty,
      noun: "Passes",
      control: "distribution passes",
      presets: DISTRIBUTION_PRESETS,
      presetLabel: (qty: number) => String(qty),
      buy: (qty: number) => `Buy D-Tokens • ${usd(qty * D_TOKEN_USD)}`,
    },
    {
      tokenType: "artist_token" as const,
      title: "Artist Tokens",
      amount: usd(ARTIST_TOKEN_USD),
      per: " / token",
      copy: "Direct artist patronage. 1 Token unlocks an uncompressed 24-bit broadcast master download and sends $1.00 directly to support the creator.",
      qty: artistQty,
      noun: "Tokens",
      control: "artist tokens",
      presets: ARTIST_PRESETS,
      presetLabel: (qty: number) => `$${qty * ARTIST_TOKEN_USD}`,
      buy: (qty: number) => `Artist Tokens • ${usd(qty * ARTIST_TOKEN_USD)}`,
    },
  ];

  return (
    <div className="relative mt-8">
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div className="absolute top-1/3 left-10 w-80 h-80 bg-red-600/20 rounded-full blur-[120px] pointer-events-none" />
        <div className="absolute top-1/2 right-10 w-80 h-80 bg-blue-600/15 rounded-full blur-[140px] pointer-events-none" />
      </div>
      <div className="relative z-10">
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
                <article key={membership.id} className={cn("relative flex min-w-0 flex-col", GLASS_CARD)}>
                  {featured ? (
                    <span className="absolute -top-3.5 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-red-600 px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-white">
                      Most Popular
                    </span>
                  ) : null}
                  <h3 className="min-w-0 text-balance break-words text-lg font-semibold leading-snug text-white">
                    {membership.name}
                  </h3>
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
              <article key={pack.id} className={cn("relative flex min-w-0 flex-col", GLASS_CARD)}>
                <h3 className="min-w-0 text-balance break-words text-lg font-semibold leading-snug text-white">
                  {pack.name}
                </h3>
                <p className="mt-2 flex-1 text-sm text-zinc-300">
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
            {`Buy a studio run at ${usd(HYBRID_TOKEN_USD)} per Hybrid Token, a Too Lost distribution pass at ${usd(D_TOKEN_USD)} per D-Token, or Artist Tokens for direct support at ${usd(ARTIST_TOKEN_USD)} each.`}
          </p>
          <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
            {standalone.map((card) => (
              <article
                key={card.tokenType}
                className={cn(
                  "relative flex min-w-0 flex-col overflow-hidden",
                  GLASS_CARD,
                  "hover:border-red-500/30",
                )}
              >
                <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-red-600" />
                <h3 className="min-w-0 text-balance break-words text-lg font-semibold leading-snug text-white">
                  {card.title}
                </h3>
                <p className="mt-2 text-4xl font-bold text-white">
                  {card.amount}
                  <span className="text-base font-normal text-zinc-400">{card.per}</span>
                </p>
                <p className="mt-2 flex-1 text-sm text-zinc-300">{card.copy}</p>
                <QuantityControl
                  label={card.control}
                  noun={card.noun}
                  quantity={card.qty}
                  disabled={busy}
                  onChange={(next) => setTokenQty(card.tokenType, next)}
                />
                <QuantityPresets
                  presets={card.presets}
                  quantity={card.qty}
                  disabled={busy}
                  labelFor={card.presetLabel}
                  onSelect={(qty) => setTokenQty(card.tokenType, qty)}
                />
                <button
                  type="button"
                  disabled={busy}
                  aria-live="polite"
                  onClick={() => void buySingle(card.tokenType, card.qty)}
                  className={RED_BUY}
                >
                  {pending === card.tokenType ? "Redirecting to Stripe..." : card.buy(card.qty)}
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
    </div>
  );
}
