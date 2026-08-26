import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Check, Film, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { supabase } from "@/integrations/supabase/client";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import {
  createVTokenCheckoutSession,
  creditVTokenPurchase,
  getVTokenBalance,
} from "@/lib/v-tokens.functions";
import {
  V_TOKEN_BUNDLES,
  vPerTokenLabel,
  vRuntimeLabel,
  vUsdLabel,
  type VTokenBundle,
} from "@/lib/v-tokens";
import { SITE_URL } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

const TITLE = "Buy V Tokens — Hybrid AI Records";
const DESCRIPTION =
  "Top up V Tokens for the V Engine. One V Token = $12.50 = 1 minute of cinematic video — buy a pack and render any time.";

export const Route = createFileRoute("/v-tokens")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/v-tokens` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/v-tokens` }],
  }),
  component: VTokensPage,
});

type Phase =
  | { kind: "browse" }
  | { kind: "loading"; priceId: string }
  | { kind: "checkout"; clientSecret: string; bundle: VTokenBundle }
  | { kind: "error"; message: string };

function VTokensPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "browse" });
  const [notice, setNotice] = useState<string | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const result = await getVTokenBalance({ data: undefined });
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
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [refreshBalance]);

  // Credit the purchase when Stripe returns the buyer to this page.
  useEffect(() => {
    if (!signedIn) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get("v_token_session");
    if (!sessionId) return;
    void (async () => {
      const result = await creditVTokenPurchase({
        data: { sessionId, environment: getStripeEnvironment() },
      });
      if (result.ok) {
        setBalance(result.balance);
        setPhase({ kind: "browse" });
        setNotice(
          result.credited > 0
            ? `🎬 ${result.credited} V Token${result.credited === 1 ? "" : "s"} added to your account.`
            : result.alreadyCredited
              ? "Those V Tokens were already credited."
              : "Payment wasn't completed — no V Tokens were added.",
        );
        window.dispatchEvent(
          new CustomEvent("hybrid:v-tokens-changed", { detail: { balance: result.balance } }),
        );
      } else {
        setNotice(result.error);
      }
      params.delete("v_token_session");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    })();
  }, [signedIn]);

  const buy = useCallback(async (bundle: VTokenBundle) => {
    setNotice(null);
    setPhase({ kind: "loading", priceId: bundle.priceId });
    try {
      const result = await createVTokenCheckoutSession({
        data: {
          priceId: bundle.priceId,
          returnUrl: `${window.location.origin}/v-tokens?v_token_session={CHECKOUT_SESSION_ID}`,
          environment: getStripeEnvironment(),
        },
      });
      if ("error" in result) {
        setPhase({ kind: "error", message: result.error });
        return;
      }
      setPhase({ kind: "checkout", clientSecret: result.clientSecret, bundle });
    } catch {
      setPhase({
        kind: "error",
        message: "We couldn't reach the payment service. Try again in a moment.",
      });
    }
  }, []);

  return (
    <main className="min-h-dvh bg-background pb-16">
      <div className="mx-auto w-full max-w-3xl px-4 pt-10">
        <PortalBreadcrumb
          trail={[{ label: "Visual Engine", to: "/cinematic-studio" }, { label: "Buy V Tokens" }]}
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Buy V Tokens</h1>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-semibold"
            aria-live="polite"
          >
            <Film className="size-4 text-primary" aria-hidden />
            {signedIn ? (balance ?? "—") : 0} V Tokens
          </span>
        </div>
        <p className="mt-2 text-muted-foreground">
          One V Token renders 1 minute of V Engine video at $12.50. Render time is billed per minute,
          rounded up — a 3:30 track costs 4 V Tokens ($50.00). V Tokens never expire.
        </p>

        {notice ? (
          <p role="status" className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            {notice}
          </p>
        ) : null}

        {!signedIn ? (
          <Card className="mt-6">
            <CardContent className="p-6 text-sm text-muted-foreground">
              Sign in first so we can credit the V Tokens to your account.{" "}
              <Link to="/auth" className="font-semibold text-primary underline">
                Sign in
              </Link>
            </CardContent>
          </Card>
        ) : phase.kind === "checkout" ? (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Paying for <strong>{phase.bundle.name}</strong> — {phase.bundle.tokens} V Tokens for{" "}
                {vUsdLabel(phase.bundle.amount)}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: "browse" })}>
                Choose a different pack
              </Button>
            </div>
            <div id="v-token-checkout">
              <EmbeddedCheckoutProvider
                stripe={getStripe()}
                options={{ clientSecret: phase.clientSecret }}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            {phase.kind === "error" ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {phase.message}
              </p>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              {V_TOKEN_BUNDLES.map((bundle) => {
                const loading = phase.kind === "loading" && phase.priceId === bundle.priceId;
                return (
                  <div
                    key={bundle.priceId}
                    className={`flex flex-col rounded-xl border p-5 ${
                      bundle.highlight
                        ? "border-primary/60 bg-primary/5 shadow-[0_0_24px_hsl(var(--primary)/0.25)]"
                        : "border-border bg-muted/10"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <h2 className="text-sm font-semibold uppercase tracking-wide">{bundle.name}</h2>
                      {bundle.highlight ? (
                        <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                          Most popular
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-3 text-3xl font-bold">{vUsdLabel(bundle.amount)}</p>
                    <p className="mt-1 flex items-center gap-1 text-sm text-primary">
                      <Film className="size-4" aria-hidden /> {bundle.tokens} V Tokens
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {vRuntimeLabel(bundle.tokens)}
                      {bundle.bonus > 0 ? ` · includes ${bundle.bonus} bonus` : ""} ·{" "}
                      {vPerTokenLabel(bundle)}
                    </p>
                    <Button
                      className="mt-5"
                      variant={bundle.highlight ? "default" : "secondary"}
                      disabled={phase.kind === "loading"}
                      onClick={() => void buy(bundle)}
                    >
                      {loading ? (
                        <>
                          <Loader2 className="size-4 animate-spin" aria-hidden /> Starting…
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-4" aria-hidden /> Buy {bundle.tokens} V Token
                          {bundle.tokens === 1 ? "" : "s"}
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> V Tokens never expire.
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Credited the moment payment
                clears.
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Secure checkout — card, Apple
                Pay and Google Pay.
              </li>
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}
