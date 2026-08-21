import { useCallback, useEffect, useState } from "react";
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from "@stripe/react-stripe-js";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getStripe, getStripeEnvironment } from "@/lib/stripe";
import { createCheckoutSession } from "@/lib/payments.functions";
import type { CurrencyCode } from "@/lib/pricing";

interface Props {
  priceId: string;
  quantity?: number;
  customerEmail?: string;
  userId?: string;
  returnUrl?: string;
  currency?: CurrencyCode;
  trackReference?: string;
}

type State =
  | { phase: "loading" }
  | { phase: "ready"; clientSecret: string }
  | { phase: "blocked"; message: string; safeOrigin: string }
  | { phase: "error"; message: string };

export function StripeEmbeddedCheckout({
  priceId,
  quantity,
  customerEmail,
  userId,
  returnUrl,
  currency,
  trackReference,
}: Props) {
  const [state, setState] = useState<State>({ phase: "loading" });

  const start = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const result = await createCheckoutSession({
        data: {
          priceId,
          quantity,
          customerEmail,
          userId,
          returnUrl: returnUrl || window.location.href,
          currency,
          trackReference,
          environment: getStripeEnvironment(),
        },
      });

      if ("error" in result) {
        if (result.code === "blocked_return_url") {
          setState({
            phase: "blocked",
            message: result.error,
            safeOrigin: result.safeOrigin ?? "https://hybrid-ai-records.com",
          });
          return;
        }
        setState({ phase: "error", message: result.error });
        return;
      }

      if (!result.clientSecret) {
        setState({
          phase: "error",
          message: "Checkout couldn't start. Please try again in a moment.",
        });
        return;
      }

      setState({ phase: "ready", clientSecret: result.clientSecret });
    } catch {
      setState({
        phase: "error",
        message:
          "We couldn't reach the payment service. Check your connection and try again.",
      });
    }
  }, [priceId, quantity, customerEmail, userId, returnUrl, currency, trackReference]);

  useEffect(() => {
    void start();
  }, [start]);

  if (state.phase === "loading") {
    return (
      <div
        className="flex min-h-40 items-center justify-center text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        Preparing secure checkout…
      </div>
    );
  }

  if (state.phase === "blocked" || state.phase === "error") {
    const blocked = state.phase === "blocked";
    const safeCheckoutUrl = blocked
      ? `${state.safeOrigin}/?checkout=${encodeURIComponent(priceId)}`
      : null;

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="rounded-lg border border-destructive/40 bg-destructive/5 p-5 backdrop-blur-sm"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden="true" />
          <div className="space-y-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {blocked ? "Checkout stopped for your safety" : "Checkout couldn't start"}
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
            </div>

            {blocked ? (
              <>
                <p className="text-sm text-muted-foreground">
                  This usually happens when the page was opened through a shared,
                  embedded, or forwarded link. Nothing was charged.
                </p>
                <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
                  <li>Open the official site below and pick your package again.</li>
                  <li>
                    Or email{" "}
                    <a
                      className="font-medium text-destructive underline underline-offset-2"
                      href="mailto:support@hybrid-ai-records.com?subject=Checkout%20blocked"
                    >
                      support@hybrid-ai-records.com
                    </a>{" "}
                    and we'll send you a secure payment link.
                  </li>
                </ul>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing was charged. Try again, or contact{" "}
                <a
                  className="font-medium text-destructive underline underline-offset-2"
                  href="mailto:support@hybrid-ai-records.com?subject=Checkout%20problem"
                >
                  support@hybrid-ai-records.com
                </a>
                .
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {safeCheckoutUrl ? (
                <Button asChild size="sm">
                  <a href={safeCheckoutUrl} rel="noopener">
                    <ExternalLink className="size-4" aria-hidden="true" />
                    Continue on the official site
                  </a>
                </Button>
              ) : (
                <Button size="sm" onClick={() => void start()}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Try again
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div id="checkout">
      <EmbeddedCheckoutProvider
        stripe={getStripe()}
        options={{ clientSecret: state.clientSecret }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}
