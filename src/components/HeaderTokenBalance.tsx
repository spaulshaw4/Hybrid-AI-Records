import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { DEV_TEST_TOKEN_BALANCE, isDevAuthBypass } from "@/lib/dev-auth";
import { planName, type SubscriptionPlanName } from "@/lib/subscription-plans";
import { getTokenBalance } from "@/lib/tokens.functions";
import { openSiteSignIn } from "@/components/studio/UserAuthButton";

type BalanceResult = { balance: number; dTokens: number; plan: SubscriptionPlanName };

type AccountSnap = {
  balance: number | null;
  dTokens: number | null;
  plan: SubscriptionPlanName;
  signedIn: boolean;
  ready: boolean;
};

const INITIAL: AccountSnap = {
  balance: null,
  dTokens: null,
  plan: "Free",
  signedIn: false,
  ready: false,
};

let snap: AccountSnap = INITIAL;
const listeners = new Set<() => void>();
let subscribers = 0;
let stopAccount: (() => void) | null = null;
let latestFetch: ((args: { data: undefined }) => Promise<BalanceResult>) | null = null;

function update(patch: Partial<AccountSnap>) {
  snap = { ...snap, ...patch };
  listeners.forEach((listener) => listener());
}

function startAccount(): () => void {
  let cancelled = false;

  const refresh = async () => {
    const fetchBalance = latestFetch;
    if (!fetchBalance) return;
    try {
      const result = await fetchBalance({ data: undefined });
      if (cancelled) return;
      update({
        balance: result.balance,
        dTokens: result.dTokens,
        plan: result.plan ?? planName(null, null),
        signedIn: true,
        ready: true,
      });
    } catch {
      if (cancelled) return;
      if (isDevAuthBypass()) {
        update({
          balance: DEV_TEST_TOKEN_BALANCE,
          dTokens: 0,
          plan: "Free",
          signedIn: true,
          ready: true,
        });
        return;
      }
      update({ balance: null, dTokens: null, plan: "Free", signedIn: false, ready: true });
    }
  };

  const signedOut = () => {
    update({ balance: null, dTokens: null, plan: "Free", signedIn: false, ready: true });
  };

  void supabase.auth.getSession().then(({ data }) => {
    if (cancelled) return;
    if (data.session) void refresh();
    else signedOut();
  });

  const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
    if (session) void refresh();
    else signedOut();
  });

  const onChanged = (event: Event) => {
    const next = (event as CustomEvent<{ balance?: number }>).detail?.balance;
    if (typeof next === "number") update({ balance: next, signedIn: true, ready: true });
    else void refresh();
  };
  window.addEventListener("hybrid:tokens-changed", onChanged);

  return () => {
    cancelled = true;
    sub.subscription.unsubscribe();
    window.removeEventListener("hybrid:tokens-changed", onChanged);
  };
}

/** One shared read for the plan badge and the token pill. */
function useHeaderAccount(): AccountSnap {
  const fetchBalance = useServerFn(getTokenBalance);
  latestFetch = fetchBalance as (args: { data: undefined }) => Promise<BalanceResult>;
  const [state, setState] = useState(snap);

  useEffect(() => {
    const listener = () => setState(snap);
    listeners.add(listener);
    subscribers += 1;
    if (subscribers === 1) stopAccount = startAccount();
    return () => {
      listeners.delete(listener);
      subscribers -= 1;
      if (subscribers === 0) {
        stopAccount?.();
        stopAccount = null;
        snap = INITIAL;
      }
    };
  }, []);

  return state;
}

const PILL =
  "header-token-pill flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs text-white sm:px-2.5";

/**
 * Live plan label. Paid tiers come from profiles.subscription_tier when status is active.
 * Signed-out and unpaid sessions read Free.
 */
export function PlanBadge() {
  const { plan } = useHeaderAccount();
  return (
    <span className="shrink-0 whitespace-nowrap rounded border border-red-500/30 bg-red-600/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-red-400">
      {plan || "Free"}
    </span>
  );
}

/**
 * Center pill: Hybrid Tokens and D-Tokens, or Sign In when there is no session.
 * The plus always opens plans. Dev bypass still falls back to the local test balance
 * only after a session check fails to return numbers.
 */
function HeaderTokenBalanceBase({ className = "" }: { className?: string }) {
  const { balance, dTokens, signedIn, ready } = useHeaderAccount();
  const hybridLabel = balance ?? "—";
  const dLabel = dTokens ?? "—";

  const plus = (
    <Link
      to="/portal"
      search={{ tab: "plans" }}
      aria-label="Open plans"
      className="header-token-plus inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-white"
    >
      <Plus className="size-3" strokeWidth={3} />
    </Link>
  );

  if (!ready) {
    return (
      <div className={`${PILL} ${className}`} aria-busy="true" aria-label="Loading token balance">
        <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
        <span className="text-zinc-400">…</span>
        {plus}
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className={`${PILL} ${className}`}>
        <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
        <button type="button" onClick={openSiteSignIn} className="truncate font-semibold">
          Sign In
        </button>
        {plus}
      </div>
    );
  }

  return (
    <div className={`${PILL} ${className}`}>
      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
      <Link
        to="/portal"
        search={{ tab: "plans" }}
        aria-label={`${hybridLabel} Hybrid Tokens, ${dLabel} D-Tokens. Open plans.`}
        className="flex min-w-0 flex-col gap-0.5 leading-none sm:flex-row sm:items-baseline sm:gap-1.5"
      >
        <span className="truncate">
          <span className="font-semibold">{hybridLabel}</span>
          <span className="text-[10px] text-zinc-400"> Hybrid Tokens</span>
        </span>
        <span className="truncate">
          <span className="font-semibold">{dLabel}</span>
          <span className="text-[10px] text-zinc-400"> D-Tokens</span>
        </span>
      </Link>
      {plus}
    </div>
  );
}

/** Memoised: token refreshes repaint only this badge, never the whole header. */
export const HeaderTokenBalance = memo(HeaderTokenBalanceBase);
