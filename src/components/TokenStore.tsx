import { useCallback, useEffect, useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { Sparkles, Check } from "lucide-react";

import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import {
  createTokenCheckoutSession,
  creditTokenPurchase,
  getTokenBalance,
} from "@/lib/tokens.functions";
import { TOKEN_BUNDLES, perTokenLabel, usdLabel, type TokenBundle } from "@/lib/tokens";
import { useCurrency } from "@/lib/currency";
import { convertFromUsd } from "@/lib/fx";
import { CURRENCIES, surchargePercent, type CurrencyCode } from "@/lib/pricing";

function tokenBundleAmountMinor(bundle: TokenBundle, currency: CurrencyCode): number {
  if (currency === "usd") return bundle.amount;
  const converted = convertFromUsd(bundle.amount, currency);
  if (converted == null) return bundle.amount;
  const bps = Math.round(surchargePercent(currency) * 100);
  return bps === 0 ? converted : Math.ceil((converted * (10_000 + bps)) / 10_000);
}

function tokenBundlePriceLabel(bundle: TokenBundle, currency: CurrencyCode): string {
  if (currency === "usd") return usdLabel(bundle.amount);
  const minor = tokenBundleAmountMinor(bundle, currency);
  const meta = CURRENCIES[currency];
  try {
    return new Intl.NumberFormat(meta.locale, {
      style: "currency",
      currency: currency.toUpperCase(),
      currencyDisplay: "narrowSymbol",
    }).format(minor / 100);
  } catch {
    return `${meta.symbol}${(minor / 100).toFixed(2)}`;
  }
}

type Phase =
  | { kind: "browse" }
  | { kind: "loading" }
  | { kind: "checkout"; clientSecret: string }
  | { kind: "error"; message: string };

/**
 * Header badge + token store. Shows the signed-in user's Hybrid Token balance,
 * sells bundles through embedded Stripe Checkout and credits the tokens as soon
 * as the buyer lands back on /studio?token_session=...
 */
export function TokenStore({
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  /** Controlled mode: render the store purely as a top-up modal. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
} = {}) {
  const [signedIn, setSignedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next);
    onOpenChange?.(next);
  };
  const [phase, setPhase] = useState<Phase>({ kind: "browse" });
  const [notice, setNotice] = useState<string | null>(null);
  const currency = useCurrency();

  const refreshBalance = useCallback(async () => {
    try {
      const result = await getTokenBalance({ data: undefined });
      setBalance(result.balance);
    } catch {
      setBalance(null);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSignedIn(Boolean(data.session));
      if (data.session) await refreshBalance();
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
      if (session) void refreshBalance();
      else setBalance(null);
    });
    // Any part of the app (e.g. the studio spending a token) can ask the
    // header counter to refresh, or push an exact new balance.
    const onTokensChanged = (event: Event) => {
      const next = (event as CustomEvent<{ balance?: number }>).detail?.balance;
      if (typeof next === "number") setBalance(next);
      else void refreshBalance();
    };
    window.addEventListener("hybrid:tokens-changed", onTokensChanged);
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      window.removeEventListener("hybrid:tokens-changed", onTokensChanged);
    };
  }, [refreshBalance]);


  // Credit tokens on return from Stripe, then clean the URL.
  useEffect(() => {
    if (!signedIn) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("token_session");
    if (!sessionId) return;
    void (async () => {
      const result = await creditTokenPurchase({
        data: { sessionId, environment: getStripeEnvironment() },
      });
      if (result.ok) {
        setBalance(result.balance);
        setNotice(
          result.credited > 0
            ? `⚡ ${result.credited} Hybrid Tokens added to your account.`
            : result.alreadyCredited
              ? "Those tokens were already credited."
              : "Payment wasn't completed — no tokens were added.",
        );
      } else {
        setNotice(result.error);
      }
      params.delete("token_session");
      const query = params.toString();
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}`,
      );
    })();
  }, [signedIn]);

  const buy = useCallback(async (bundle: TokenBundle) => {
    setPhase({ kind: "loading" });
    try {
      const result = await createTokenCheckoutSession({
        data: {
          priceId: bundle.priceId,
          returnUrl: `${window.location.origin}${window.location.pathname}?token_session={CHECKOUT_SESSION_ID}`,
          environment: getStripeEnvironment(),
          currency,
        },
      });
      if ("error" in result) {
        setPhase({ kind: "error", message: result.error });
        return;
      }
      setPhase({ kind: "checkout", clientSecret: result.clientSecret });
    } catch {
      setPhase({
        kind: "error",
        message: "We couldn't reach the payment service. Try again in a moment.",
      });
    }
  }, [currency]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      {hideTrigger ? null : (
      <>
      <span
        className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-semibold text-foreground"
        aria-live="polite"
      >
        <HybridTokenIcon className="size-4 text-primary" />
        {signedIn ? (balance ?? "—") : "0"} Hybrid Tokens
      </span>

      <Button
        size="sm"
        onClick={() => {
          setPhase({ kind: "browse" });
          setOpen(true);
        }}
        className="shadow-[0_0_18px_hsl(var(--primary)/0.55)] transition-shadow hover:shadow-[0_0_28px_hsl(var(--primary)/0.8)]"
      >
        <Sparkles className="size-4" aria-hidden />
        Buy Tokens
      </Button>
      </>
      )}

      {notice ? (
        <p className="w-full text-xs text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          overlayClassName="bg-zinc-950/80 backdrop-blur-md"
          className="overflow-y-auto !border-white/10 modal-panel-solid shadow-2xl sm:max-h-[90dvh] sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <HybridTokenIcon className="size-5 text-primary" /> Hybrid Token Store
            </DialogTitle>
            <DialogDescription className="text-zinc-300">
              Tokens power the Hybrid Engine 1.0 Alpha. Buy once, spend any time.
            </DialogDescription>
          </DialogHeader>

          {!signedIn ? (
            <p className="rounded-lg border border-white/10 bg-zinc-900 p-4 text-sm text-zinc-300">
              Sign in to buy Hybrid Tokens so we can credit them to your account.
            </p>
          ) : phase.kind === "checkout" ? (
            <div id="token-checkout" className="rounded-lg bg-zinc-950">
              <EmbeddedCheckoutProvider
                stripe={getStripe()}
                options={{ clientSecret: phase.clientSecret }}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          ) : (
            <div className="space-y-4">
              {phase.kind === "error" ? (
                <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  {phase.message}
                </p>
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                {TOKEN_BUNDLES.map((bundle) => (
                  <div
                    key={bundle.priceId}
                    className={`flex flex-col rounded-xl border p-4 ${
                      bundle.highlight
                        ? "border-primary/60 bg-zinc-900 shadow-[0_0_24px_hsl(var(--primary)/0.25)]"
                        : "border-white/10 bg-zinc-900"
                    }`}
                  >
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-50">
                      {bundle.name}
                    </h3>
                    <p className="mt-2 text-2xl font-bold text-white">
                      {tokenBundlePriceLabel(bundle, currency)}
                    </p>
                    <p className="mt-1 flex items-center gap-1 text-sm text-primary">
                      <HybridTokenIcon className="size-4" /> {bundle.tokens} Hybrid Tokens
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {bundle.bonus > 0
                        ? `Includes ${bundle.bonus} bonus tokens`
                        : currency === "usd"
                          ? perTokenLabel(bundle)
                          : "Priced in your selected currency"}
                    </p>
                    <Button
                      className="mt-4"
                      size="sm"
                      variant={bundle.highlight ? "default" : "secondary"}
                      disabled={phase.kind === "loading"}
                      onClick={() => void buy(bundle)}
                    >
                      {phase.kind === "loading" ? "Starting…" : `Buy ${bundle.tokens} tokens`}
                    </Button>
                  </div>
                ))}
              </div>

              <ul className="space-y-1 text-xs text-zinc-400">
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary" aria-hidden /> Tokens never expire.
                </li>
                <li className="flex items-center gap-2">
                  <Check className="size-3.5 text-primary" aria-hidden /> Credited to your account the moment payment clears.
                </li>
              </ul>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
