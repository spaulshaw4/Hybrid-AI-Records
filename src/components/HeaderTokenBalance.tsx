import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { memo, useCallback, useEffect, useState } from "react";

import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { supabase } from "@/integrations/supabase/client";
import { getTokenBalance } from "@/lib/tokens.functions";

/**
 * Compact header widget: shows the signed-in visitor's Hybrid Token balance and
 * a direct "Buy" entry point to /tokens. Refreshes on auth changes and on the
 * app-wide `hybrid:tokens-changed` event raised by the engine.
 */
function HeaderTokenBalanceBase({ className = "" }: { className?: string }) {
  const fetchBalance = useServerFn(getTokenBalance);
  const [signedIn, setSignedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await fetchBalance({ data: undefined });
      setBalance(result.balance);
    } catch {
      setBalance(null);
    }
  }, [fetchBalance]);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSignedIn(Boolean(data.session));
      if (data.session) void refresh();
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setSignedIn(Boolean(session));
      if (session) void refresh();
      else setBalance(null);
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

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <Link
        to="/tokens"
        aria-label="Hybrid Token balance — buy more tokens"
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-primary transition-colors hover:bg-primary/20"
      >
        <HybridTokenIcon className="size-4 text-primary" />
        {balance ?? "—"} Tokens
      </Link>
      <Link
        to="/tokens"
        className="inline-flex rounded-full border border-border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.12em] text-foreground/80 transition-colors hover:text-foreground"
      >
        Buy tokens
      </Link>
    </div>
  );

}

/** Memoised: token refreshes repaint only this badge, never the whole header. */
export const HeaderTokenBalance = memo(HeaderTokenBalanceBase);
