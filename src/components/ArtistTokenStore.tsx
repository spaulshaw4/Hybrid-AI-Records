import { useCallback, useEffect, useRef, useState } from "react";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { Download, Check } from "lucide-react";
import { toast } from "sonner";

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
  ARTIST_TOKEN_BUNDLES,
  ARTIST_TOKEN_RETURN_PARAM,
  artistUsdLabel,
  type ArtistTokenBundle,
} from "@/lib/artist-tokens";
import {
  createArtistTokenCheckoutSession,
  creditArtistTokenPurchase,
  getArtistTokenState,
  unlockTrackDownload,
} from "@/lib/artist-tokens.functions";

type Phase =
  | { kind: "browse" }
  | { kind: "loading" }
  | { kind: "checkout"; clientSecret: string }
  | { kind: "error"; message: string };

export type ArtistTokens = ReturnType<typeof useArtistTokens>;

/**
 * Artist Tokens ($1 each) — one token unlocks one permanent catalog download.
 * The hook owns the balance, the set of unlocked tracks, and the store modal.
 */
export function useArtistTokens() {
  const [signedIn, setSignedIn] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [storeOpen, setStoreOpen] = useState(false);
  const [busyTrack, setBusyTrack] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const state = await getArtistTokenState({ data: undefined });
      setBalance(state.balance);
      setUnlocked(new Set(state.unlocked));
      setNotice(null);
    } catch {
      // A failed read must not look like an empty wallet.
      setBalance(null);
      setNotice("We couldn't load your Artist Token balance. Check your connection and try again.");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSignedIn(Boolean(data.session));
      if (data.session) await refresh();
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(Boolean(session));
      if (session) void refresh();
      else {
        setBalance(null);
        setUnlocked(new Set());
      }
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [refresh]);

  // Credit Artist Tokens when the buyer lands back from Stripe, then clean the URL.
  useEffect(() => {
    if (!signedIn) return;
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get(ARTIST_TOKEN_RETURN_PARAM);
    if (!sessionId) return;
    void (async () => {
      const result = await creditArtistTokenPurchase({
        data: { sessionId, environment: getStripeEnvironment() },
      });
      if (result.ok) {
        setBalance(result.balance);
        const message =
          result.credited > 0
            ? `${result.credited} Artist Token${result.credited === 1 ? "" : "s"} added — pick your downloads.`
            : result.alreadyCredited
              ? "Those Artist Tokens were already credited."
              : "Payment wasn't completed — no tokens were added.";
        setNotice(message);
        if (result.credited > 0) {
          toast.success("Purchase confirmed", {
            description: `${message} New balance: ${result.balance} token${result.balance === 1 ? "" : "s"}. A receipt is on its way to your email.`,
          });
        } else if (result.alreadyCredited) {
          toast.info(message);
        } else {
          toast.error(message);
        }
      } else {
        setNotice(result.error);
        toast.error(result.error);
      }

      params.delete(ARTIST_TOKEN_RETURN_PARAM);
      const query = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    })();
  }, [signedIn]);

  /** True while an unlock/download request is in flight. */
  const unlockingRef = useRef(false);

  const download = useCallback(
    async (trackId: string) => {
      if (!signedIn) {
        setNotice("Sign in to download tracks with Artist Tokens.");
        return;
      }
      // Ref guard: React state updates are async, so two taps in the same
      // tick would both pass a `busyTrack` check. This one blocks instantly
      // and covers every track, not just the one being tapped.
      if (unlockingRef.current) return;
      unlockingRef.current = true;
      setBusyTrack(trackId);
      setNotice(null);
      try {
        const result = await unlockTrackDownload({ data: { trackId } });
        if (!result.ok) {
          setBalance(result.balance);
          setNotice(result.error);
          toast.error(result.error);
          if (/not enough/i.test(result.error)) setStoreOpen(true);
          return;
        }
        setBalance(result.balance);
        setUnlocked((prev) => new Set(prev).add(trackId));
        const a = document.createElement("a");
        a.href = result.url;
        a.download = result.fileName;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        const unlockMessage = result.alreadyOwned
          ? "Already unlocked — downloading again is free."
          : "Track unlocked. Your download is starting.";
        setNotice(unlockMessage);
        toast.success(result.alreadyOwned ? "Download started" : "Track unlocked", {
          description: result.alreadyOwned
            ? unlockMessage
            : `1 Artist Token used · ${result.balance} left. A confirmation email is on its way.`,
        });
      } catch {
        setNotice("We couldn't start that download. Try again.");
        toast.error("We couldn't start that download. Try again.");
      } finally {
        unlockingRef.current = false;
        setBusyTrack(null);
      }
    },
    [signedIn],
  );

  return {
    signedIn,
    balance,
    unlocked,
    busyTrack,
    notice,
    storeOpen,
    setStoreOpen,
    setNotice,
    download,
  };
}

/** The purchase modal + inline status line. Render once next to the catalog. */
export function ArtistTokenStore({ tokens }: { tokens: ArtistTokens }) {
  const [phase, setPhase] = useState<Phase>({ kind: "browse" });

  const buy = useCallback(async (bundle: ArtistTokenBundle) => {
    setPhase({ kind: "loading" });
    try {
      const result = await createArtistTokenCheckoutSession({
        data: {
          priceId: bundle.priceId,
          returnUrl: `${window.location.origin}${window.location.pathname}?${ARTIST_TOKEN_RETURN_PARAM}={CHECKOUT_SESSION_ID}`,
          environment: getStripeEnvironment(),
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
  }, []);

  return (
    <Dialog
      open={tokens.storeOpen}
      onOpenChange={(open) => {
        tokens.setStoreOpen(open);
        if (!open) setPhase({ kind: "browse" });
      }}
    >
      <DialogContent className="overflow-y-auto border-border bg-background/95 backdrop-blur sm:max-h-[90dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-5 text-primary" aria-hidden /> Artist Tokens
          </DialogTitle>
          <DialogDescription>
            $1 per token. One token unlocks one track download from the catalog — keep it forever.
          </DialogDescription>
        </DialogHeader>

        {!tokens.signedIn ? (
          <p className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            Sign in to buy Artist Tokens so we can credit them to your account.
          </p>
        ) : phase.kind === "checkout" ? (
          <div id="artist-token-checkout">
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
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                {phase.message}
              </p>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {ARTIST_TOKEN_BUNDLES.map((bundle) => (
                <div
                  key={bundle.priceId}
                  className={`flex flex-col rounded-xl border p-4 ${
                    bundle.highlight
                      ? "border-primary/60 bg-primary/5 shadow-[0_0_24px_hsl(var(--primary)/0.25)]"
                      : "border-border bg-muted/10"
                  }`}
                >
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground">
                    {bundle.name}
                  </h3>
                  <p className="mt-2 text-2xl font-bold text-foreground">
                    {artistUsdLabel(bundle.amount)}
                  </p>
                  <p className="mt-1 text-sm text-primary">
                    {bundle.tokens} Artist Token{bundle.tokens === 1 ? "" : "s"}
                  </p>
                  <Button
                    className="mt-4"
                    size="sm"
                    variant={bundle.highlight ? "default" : "secondary"}
                    disabled={phase.kind === "loading"}
                    onClick={() => void buy(bundle)}
                  >
                    {phase.kind === "loading" ? "Starting…" : `Buy ${bundle.tokens}`}
                  </Button>
                </div>
              ))}
            </div>

            <ul className="space-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Artist Tokens never expire.
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Unlocked tracks stay
                downloadable from your account.
              </li>
              <li className="flex items-center gap-2">
                <Check className="size-3.5 text-primary" aria-hidden /> Personal listening use only —
                see the licensing terms.
              </li>
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
