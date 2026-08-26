import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import { SERVICES } from "@/lib/services";
import { useMoneyFormat } from "@/lib/money-format";
import { useCurrency } from "@/lib/currency";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { useStripeCheckout } from "@/hooks/useStripeCheckout";
import { PayNowModal } from "@/components/PayNowModal";
import type { ServicePackage } from "@/lib/services";
import { Wordmark } from "@/components/Wordmark";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";

export const Route = createFileRoute("/start/")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/start",
      title: "Start a Track — Hybrid AI Records",
      description: "Choose your package: The Foundation, The Visual Push, or The Full Hybrid Experience. Apply for review or pay for a single track instantly.",
      socialTitle: "Start a Track — Hybrid AI Records",
      socialDescription: "Three release packages, fixed pricing, total artist ownership. Apply for review or pay for a single track instantly.",
      type: "website",
      card: "summary_large_image",
    }),
  component: StartPage,
});

function StartPage() {
  const currency = useCurrency();
  const { label: priceLabel } = useMoneyFormat();
  const { openCheckout, closeCheckout, isOpen: checkoutOpen, checkoutElement } = useStripeCheckout();

  const [payNow, setPayNow] = useState<ServicePackage | null>(null);

  const startPaidOrder = (pkg: ServicePackage, reference: string, email: string) => {
    setPayNow(null);
    openCheckout({
      priceId: pkg.priceIdSingle,
      currency,
      customerEmail: email,
      trackReference: reference,
      returnUrl: `${window.location.origin}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    });
  };

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 border-b border-border bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <Link to="/" aria-label="Hybrid AI Records home">
            <Wordmark />
          </Link>
          <Link to="/" className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary">
            ← Back to site
          </Link>
        </div>
      </header>

      <section className="relative py-14 md:py-20">
        <div className="mx-auto max-w-7xl px-6">
          <div className="mb-12 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <div className="eyebrow">
                <span className="text-[#e11d2e]">/ Start</span>{" "}
                <span className="text-white">a</span>{" "}
                <span className="text-[#4b8bff]">Track</span>
              </div>
              <h1 className="mt-4 max-w-2xl font-display text-4xl font-bold leading-[1.02] tracking-tight sm:text-6xl">
                <span className="text-[#e11d2e]">Pick your</span> <span className="text-white">package.</span>
                <br />
                <span className="text-[#4b8bff]">Apply or pay now.</span>
              </h1>
            </div>
            <div className="flex max-w-md flex-col items-start gap-4 md:items-end">
              <p className="text-sm text-muted-foreground md:text-end">
                Apply for review if you want us to look at your project first — or pay for a single
                track straight away and we'll start the intake immediately after checkout.
              </p>
              <CurrencySwitcher />
              <Link
                to="/start/onboarding"
                className="inline-flex items-center gap-2 border border-[#4b8bff] bg-[#4b8bff]/10 px-4 py-2 text-xs font-semibold uppercase tracking-widest text-[#4b8bff] transition-colors hover:bg-[#4b8bff]/20"
              >
                Not sure? Take the guided intake →
              </Link>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-px bg-border/60 lg:grid-cols-3">
            {SERVICES.map((s) => (
              <div
                key={s.n}
                className="group relative flex flex-col gap-5 bg-background/25 p-8 backdrop-blur-sm transition-colors hover:bg-background/45"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-medium" style={{ color: s.color }}>/ {s.n}</span>
                  <span className="mx-4 h-px flex-1 bg-border" />
                  <ArrowUpRight size={16} style={{ color: s.color }} />
                </div>

                <div>
                  <h2 className="font-display text-2xl font-semibold leading-tight" style={{ color: s.color }}>
                    {s.title}
                  </h2>
                  <p className="mt-1 text-xs uppercase tracking-[0.2em] text-muted-foreground">{s.tagline}</p>
                </div>

                <div className="border-y border-border/60 py-4">
                  <div className="font-display text-3xl font-bold text-white">
                    {priceLabel(s.priceIdSingle, currency) ?? s.priceSingle} / track
                  </div>
                </div>

                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-[#e11d2e]">You bring</dt>
                    <dd className="mt-1 text-muted-foreground">{s.bring}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-white">We do</dt>
                    <dd className="mt-1 text-muted-foreground">{s.do}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wider text-[#4b8bff]">You get</dt>
                    <dd className="mt-1 text-muted-foreground">{s.get}</dd>
                  </div>
                </dl>

                <div className="flex flex-col gap-3 pt-2">
                  <Link
                    to="/start/$package"
                    params={{ package: s.slug }}
                    search={{ mode: "single", step: undefined }}
                    className="block w-full bg-[#e11d2e] px-4 py-3 text-center text-sm font-semibold uppercase tracking-widest text-white shadow-[0_10px_30px_-12px_rgba(225,29,46,0.7)] transition-all hover:bg-[#c81828] hover:shadow-[0_14px_40px_-10px_rgba(225,29,46,0.9)]"
                  >
                    Apply — Single Track ({priceLabel(s.priceIdSingle, currency) ?? s.priceSingle})
                  </Link>
                  <button
                    type="button"
                    onClick={() => setPayNow(s)}
                    className="w-full border border-[#4b8bff] bg-[#4b8bff]/10 px-4 py-3 text-sm font-semibold uppercase tracking-widest text-[#4b8bff] transition-all hover:bg-[#4b8bff] hover:text-black hover:shadow-[0_0_28px_-4px_rgba(75,139,255,0.85)]"
                  >
                    Pay Now — Single Track ({priceLabel(s.priceIdSingle, currency) ?? s.priceSingle})
                  </button>
                </div>

                <div className={`mt-auto h-[2px] w-8 ${s.accent} transition-all duration-300 group-hover:w-16`} />
              </div>
            ))}
          </div>

          <p className="mt-8 text-xs text-muted-foreground">
            Every order covers one single track on the selected package.
          </p>
        </div>
      </section>

      {payNow && (
        <PayNowModal
          open
          packageLabel={payNow.title}
          priceLabel={priceLabel(payNow.priceIdSingle, currency) ?? payNow.priceSingle}
          onClose={() => setPayNow(null)}
          onSubmitted={({ reference, email }) => startPaidOrder(payNow, reference, email)}
        />
      )}

      {checkoutOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Checkout"
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto overlay-scrim bg-foreground/40 p-4 backdrop-blur-md sm:p-8"
          onClick={closeCheckout}
        >
          <div
            className="relative my-auto w-full max-w-3xl bg-white text-black shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeCheckout}
              className="absolute end-3 top-3 z-10 rounded-full studio-glass p-2 text-foreground transition hover:bg-white"
              aria-label="Close checkout"
            >
              <X size={18} />
            </button>
            {checkoutElement}
          </div>
        </div>
      )}
    </div>
  );
}
