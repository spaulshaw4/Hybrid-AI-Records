import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { memo, useCallback, useEffect, useState } from "react";

import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { supabase } from "@/integrations/supabase/client";
import { DEV_TEST_TOKEN_BALANCE, isDevAuthBypass } from "@/lib/dev-auth";
import type { SubscriptionPlanName } from "@/lib/subscription-plans";
import { getTokenBalance } from "@/lib/tokens.functions";

const PILL =
  "inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-primary transition-colors hover:bg-primary/20";

/**
 * Compact header widget: plan name, spendable Hybrid Tokens, D-Tokens, and a
 * Buy entry point. Hybrid count is token_balances.balance. Refreshes on auth
 * changes and on the app-wide `hybrid:tokens-changed` event raised by the engine.
 */
function HeaderTokenBalanceBase({ className = "" }: { className?: string }) {
  const fetchBalance = useServerFn(getTokenBalance);
  const [signedIn, setSignedIn] = useState(isDevAuthBypass());
  const [balance, setBalance] = useState<number | null>(
    isDevAuthBypass() ? DEV_TEST_TOKEN_BALANCE : null,
  );
  const [dTokens, setDTokens] = useState<number | null>(isDevAuthBypass() ? 0 : null);
  const [plan, setPlan] = useState<SubscriptionPlanName>("Free");

  const refresh = useCallback(async () => {
    if (isDevAuthBypass()) {
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      setDTokens((prev) => prev ?? 0);
      setPlan("Free");
      return;
    }
    try {
      const result = await fetchBalance({ data: undefined });
      setBalance(result.balance);
      setDTokens(result.dTokens);
      setPlan(result.plan);
    } catch {
      setBalance(null);
      setDTokens(null);
    }
  }, [fetchBalance]);

  useEffect(() => {
    if (isDevAuthBypass()) {
      setSignedIn(true);
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      setDTokens((prev) => prev ?? 0);
      setPlan("Free");
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      setSignedIn(Boolean(data.session));
      if (data.session) void refresh();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session));
      if (session) void refresh();
      else {
        setBalance(null);
        setDTokens(null);
        setPlan("Free");
      }
    });
    const onChanged = (event: Event) => {
      const next = (event as CustomEvent<{ balance?: number }>).detail?.balance;
      if (typeof next === "number") setBalance(next);
      else void refresh();
    };
    window.addEventListener("hybrid:tokens-changed", onChanged);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener("hybrid:tokens-changed", onChanged);
    };
  }, [refresh]);

  if (!signedIn) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        <Link
          to="/auth"
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-primary transition-colors hover:bg-primary/20"
        >
          <HybridTokenIcon className="size-4 text-primary" />
          Sign in
        </Link>
      </div>
    );
  }

  const hybridLabel = balance ?? "—";
  const dLabel = dTokens ?? "—";

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <Link
        to="/tokens"
        aria-label={`Active plan ${plan}. ${hybridLabel} Hybrid Tokens. ${dLabel} D-Tokens. Buy more tokens.`}
        className={PILL}
      >
        <span>{plan}</span>
        <span aria-hidden className="text-primary/50">·</span>
        <HybridTokenIcon className="size-4 text-primary" />
        <span className="sm:hidden">{hybridLabel}</span>
        <span className="hidden sm:inline">{hybridLabel} Tokens</span>
        <span aria-hidden className="text-primary/50">·</span>
        <span className="sm:hidden">{dLabel}D</span>
        <span className="hidden sm:inline">{dLabel} D-Tokens</span>
      </Link>
      <Link
        to="/tokens"
        className="hidden rounded-full border border-border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-foreground/80 transition-colors hover:text-foreground sm:inline-flex"
      >
        Buy tokens
      </Link>
    </div>
  );

}

/** Memoised: token refreshes repaint only this badge, never the whole header. */
export const HeaderTokenBalance = memo(HeaderTokenBalanceBase);
