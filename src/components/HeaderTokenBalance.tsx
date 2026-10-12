import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Plus } from "lucide-react";
import { memo, useCallback, useEffect, useState } from "react";

import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { supabase } from "@/integrations/supabase/client";
import { DEV_TEST_TOKEN_BALANCE, isDevAuthBypass } from "@/lib/dev-auth";
import { getTokenBalance } from "@/lib/tokens.functions";

const CAPSULE =
  "header-token-pill inline-flex h-auto min-h-9 w-auto shrink-0 flex-nowrap items-center gap-x-1 whitespace-nowrap rounded-full border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono font-semibold normal-case text-zinc-100 transition-colors hover:border-zinc-600";

/**
 * One capsule: spendable Hybrid Tokens and D-Tokens. Opens the plans tab.
 * Hybrid count is token_balances.balance. Refreshes on auth changes and on
 * the app-wide `hybrid:tokens-changed` event raised by the engine.
 */
function HeaderTokenBalanceBase({ className = "" }: { className?: string }) {
  const fetchBalance = useServerFn(getTokenBalance);
  const [balance, setBalance] = useState<number | null>(
    isDevAuthBypass() ? DEV_TEST_TOKEN_BALANCE : null,
  );
  const [dTokens, setDTokens] = useState<number | null>(isDevAuthBypass() ? 0 : null);

  const refresh = useCallback(async () => {
    if (isDevAuthBypass()) {
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      setDTokens((prev) => prev ?? 0);
      return;
    }
    try {
      const result = await fetchBalance({ data: undefined });
      setBalance(result.balance);
      setDTokens(result.dTokens);
    } catch {
      setBalance(null);
      setDTokens(null);
    }
  }, [fetchBalance]);

  useEffect(() => {
    if (isDevAuthBypass()) {
      setBalance((prev) => prev ?? DEV_TEST_TOKEN_BALANCE);
      setDTokens((prev) => prev ?? 0);
      return;
    }
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) void refresh();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (session) void refresh();
      else {
        setBalance(null);
        setDTokens(null);
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

  const hybridLabel = balance ?? "—";
  const dLabel = dTokens ?? "—";

  return (
    <Link
      to="/portal"
      search={{ tab: "plans" }}
      aria-label={`${hybridLabel} Hybrid Tokens, ${dLabel} D-Tokens. Open plans.`}
      className={`${CAPSULE} ${className}`}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
        <HybridTokenIcon className="header-token-mark size-4 shrink-0 text-red-500" />
        <span>{hybridLabel} Hybrid Tokens</span>
      </span>
      <span aria-hidden="true" className="text-zinc-500">
        •
      </span>
      <span className="whitespace-nowrap">{dLabel} D-Tokens</span>
      <span
        className="header-token-plus inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-red-600 text-white"
        aria-hidden="true"
      >
        <Plus className="size-3" strokeWidth={3} />
      </span>
    </Link>
  );
}

/** Memoised: token refreshes repaint only this badge, never the whole header. */
export const HeaderTokenBalance = memo(HeaderTokenBalanceBase);
