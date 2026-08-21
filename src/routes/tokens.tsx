import { useCallback, useEffect, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Check, Loader2, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { PaymentTestModeBanner } from "@/components/PaymentTestModeBanner";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { supabase } from "@/integrations/supabase/client";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import {
  createTokenCheckoutSession,
  creditTokenPurchase,
  getTokenBalance,
} from "@/lib/tokens.functions";
import { TOKEN_BUNDLES, perTokenLabel, usdLabel, type TokenBundle } from "@/lib/tokens";
import { LABEL_ID, SITE_URL, buildPageJsonLd } from "@/lib/release-schema";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


export const Route = createFileRoute("/tokens")({
  errorComponent: RouteErrorFallback,
  head: () => ({
    meta: [
      { title: "Buy Hybrid Tokens — Hybrid AI Records" },
      {
        name: "description",
        content:
          "Top up Hybrid Tokens any time. Pick a preset bundle, pay securely, and your balance is credited instantly for engine generations.",
      },
      { property: "og:title", content: "Buy Hybrid Tokens — Hybrid AI Records" },
      {
        property: "og:description",
        content: "Preset token bundles with secure checkout — tokens never expire.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${SITE_URL}/tokens` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `${SITE_URL}/tokens` }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/tokens",
            name: "Buy Hybrid Tokens — Hybrid AI Records",
            description:
              "Preset Hybrid Token bundles with secure checkout. Tokens power Hybrid Engine 1.0 generations and never expire.",
            breadcrumb: [{ name: "Buy Tokens", path: "/tokens" }],
            extra: [
              {
                "@type": "Product",
                "@id": `${SITE_URL}/tokens#product`,
                name: "Hybrid Tokens",
                description:
                  "Prepaid credits for Hybrid Engine 1.0 — one token generates and masters one track. Tokens never expire.",
                brand: { "@id": LABEL_ID },
                category: "Music production credits",
                url: `${SITE_URL}/tokens`,
                offers: TOKEN_BUNDLES.map((bundle) => ({
                  "@type": "Offer",
                  name: bundle.name,
                  price: (bundle.amount / 100).toFixed(2),
                  priceCurrency: "USD",
                  availability: "https://schema.org/InStock",
                  url: `${SITE_URL}/tokens`,
                  description: `${bundle.tokens} Hybrid Tokens`,
                })),
              },
            ],
          }),
        ),
      },
    ],
  }),
  component: TokensPage,
});


type Phase =
  | { kind: "browse" }
  | { kind: "loading"; priceId: string }
  | { kind: "checkout"; clientSecret: string; bundle: TokenBundle }
  | { kind: "error"; message: string };

function TokensPage() {
  const [signedIn, setSignedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "browse" });
  const [notice, setNotice] = useState<string | null>(null);

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
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [refreshBalance]);

  // Credit the purchase when Stripe returns the buyer to this page.
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
        setPhase({ kind: "browse" });
        setNotice(
          result.credited > 0
            ? `⚡ ${result.credited} Hybrid Tokens added to your account.`
            : result.alreadyCredited
              ? "Those tokens were already credited."
              : "Payment wasn't completed — no tokens were added.",
        );
        window.dispatchEvent(
          new CustomEvent("hybrid:tokens-changed", { detail: { balance: result.balance } }),
        );
      } else {
        setNotice(result.error);
      }
      params.delete("token_session");
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    })();
  }, [signedIn]);

  const buy = useCallback(async (bundle: TokenBundle) => {
    setNotice(null);
    setPhase({ kind: "loading", priceId: bundle.priceId });
    try {
      const result = await createTokenCheckoutSession({
        data: {
          priceId: bundle.priceId,
          returnUrl: `${window.location.origin}/tokens?token_session={CHECKOUT_SESSION_ID}`,
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
      <PaymentTestModeBanner />

      <div className="mx-auto w-full max-w-3xl px-4 pt-10">
        <PortalBreadcrumb
          trail={[
            { label: "Buy Tokens" },
          ]}
        />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Buy Hybrid Tokens</h1>
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-sm font-semibold"
            aria-live="polite"
          >
            <HybridTokenIcon className="size-4 text-primary" />
            {signedIn ? (balance ?? "—") : 0} Tokens
          </span>
        </div>
        <p className="mt-2 text-muted-foreground">
          One token renders and masters one track. Buy once, spend any time — tokens never expire.
        </p>

        {notice ? (
          <p role="status" className="mt-4 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">
            {notice}
          </p>
        ) : null}

        {!signedIn ? (
          <Card className="mt-6">
            <CardContent className="p-6 text-sm text-muted-foreground">
              Sign in first so we can credit the tokens to your account.{" "}
              <Link to="/auth" className="font-semibold text-primary underline">
                Sign in
              </Link>
            </CardContent>
          </Card>
        ) : phase.kind === "checkout" ? (
          <div className="mt-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Paying for <strong>{phase.bundle.name}</strong> — {phase.bundle.tokens} tokens for{" "}
                {usdLabel(phase.bundle.amount)}
              </p>
              <Button variant="ghost" size="sm" onClick={() => setPhase({ kind: "browse" })}>
                Choose a different bundle
              </Button>
            </div>
            <div id="token-checkout">
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
              {TOKEN_BUNDLES.map((bundle) => {
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
                    <p className="mt-3 text-3xl font-bold">{usdLabel(bundle.amount)}</p>
                    <p className="mt-1 flex items-center gap-1 text-sm text-primary">
                      <HybridTokenIcon className="size-4" /> {bundle.tokens} Hybrid Tokens
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {bundle.bonus > 0
                        ? `Includes ${bundle.bonus} bonus tokens · ${perTokenLabel(bundle)}`
                        : perTokenLabel(bundle)}
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
                          <Sparkles className="size-4" aria-hidden /> Buy {bundle.tokens} tokens
                        </>
                      )}
                    </Button>
                  </div>
                );
              })}
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Tokens never expire.
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
