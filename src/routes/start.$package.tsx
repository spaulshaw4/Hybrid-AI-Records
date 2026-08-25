import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { SERVICES } from "@/lib/services";
import { useMoneyFormat } from "@/lib/money-format";
import { PriceBreakdown } from "@/components/PriceBreakdown";
import { PackageStartOptions } from "@/components/PackageStartOptions";
import { useCurrency } from "@/lib/currency";
import { CurrencySwitcher } from "@/components/CurrencySwitcher";
import { useStripeCheckout } from "@/hooks/useStripeCheckout";
import { ApplicationModal, type ApplicationProgress } from "@/components/ApplicationModal";
import { PayNowModal } from "@/components/PayNowModal";
import { Wordmark } from "@/components/Wordmark";
import { FlowProgress, type FlowStep } from "@/components/FlowProgress";
import { DraftResumeBanner } from "@/components/DraftResumeBanner";
import { draftScopeFor } from "@/lib/application-drafts";
import { clearFlowState, readFlowState, writeFlowState } from "@/lib/flow-state";
import { trackFunnelEvent } from "@/lib/funnel-analytics";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


const FLOW_STEPS: FlowStep[] = [
  { id: "package", label: "Package", hint: "Chosen" },
  { id: "type", label: "Track type", hint: "Single or bundle" },
  { id: "details", label: "Your details", hint: "Application form" },
  { id: "submit", label: "Submit or pay", hint: "Review & confirm" },
];

// Shareable step slugs — /start/foundation?step=track-details returns a
// visitor to that exact point in the flow.
export const STEP_SLUGS = ["package", "track-type", "track-details", "submit"] as const;
type StepSlug = (typeof STEP_SLUGS)[number];


const stepIndexFor = (slug: string | undefined) => {
  const i = STEP_SLUGS.indexOf(slug as StepSlug);
  return i === -1 ? null : i;
};

const findPackage = (slug: string) => SERVICES.find((s) => s.slug === slug);

export const Route = createFileRoute("/start/$package")({
  errorComponent: RouteErrorFallback,
  validateSearch: (search: Record<string, unknown>) => {
    const step = String(search.step ?? "");
    const mode = String(search.mode ?? "");
    return {
      step: STEP_SLUGS.includes(step as StepSlug) ? (step as StepSlug) : undefined,
      mode: mode === "single" || mode === "bundle" ? (mode as "single" | "bundle") : undefined,
    };
  },
  loader: ({ params }) => {
    const pkg = findPackage(params.package);
    if (!pkg) throw notFound();
    return { slug: pkg.slug, title: pkg.title, tagline: pkg.tagline };
  },

  head: ({ params, loaderData }) => {
    if (!loaderData) {
      return {
        meta: [
          { title: "Package unavailable — Hybrid AI Records" },
          { name: "robots", content: "noindex" },
        ],
      };
    }
    const title = `Apply — ${loaderData.title} | Hybrid AI Records`;
    const description = `${loaderData.title}: ${loaderData.tagline}. Submit your single-track or 10-track application and pay for a single track in one place.`;
    return pageHead({
      path: `/start/${params.package}`,
      title,
      description,
      socialDescription: `${loaderData.title}: ${loaderData.tagline}.`,
      type: "website",
      imageAlt: `${loaderData.title} — Hybrid AI Records`,
    });
  },
  notFoundComponent: PackageNotFound,
  component: PackageApplyPage,
});

function PackageNotFound() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-24 text-center">
      <h1 className="font-display text-3xl font-bold">Package not found</h1>
      <p className="mt-3 text-muted-foreground">
        That package doesn&apos;t exist. Pick one from the start page.
      </p>
      <Link
        to="/start"
        className="mt-8 inline-block bg-[#e11d2e] px-6 py-3 text-sm font-semibold uppercase tracking-widest text-white"
      >
        Back to packages
      </Link>
    </div>
  );
}

function PackageApplyPage() {
  const { slug } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const pkg = findPackage(slug)!;
  const currency = useCurrency();
  const { label: priceLabel } = useMoneyFormat();
  const mode = "single" as const;
  const [typeConfirmed, setTypeConfirmed] = useState(true);
  const [formProgress, setFormProgress] = useState<ApplicationProgress>({
    detailsComplete: false,
    submitted: false,
    missing: [],
  });
  const [payNow, setPayNow] = useState(false);
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const [resumeDismissed, setResumeDismissed] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const restoredRef = useRef(false);
  const { openCheckout, closeCheckout, isOpen: checkoutOpen, checkoutElement } = useStripeCheckout();

  const singlePrice = priceLabel(pkg.priceIdSingle, currency) ?? pkg.priceSingle;

  // The indicator only moves forward when the required fields for the step in
  // question actually validate — not just because a panel was opened.
  const detailsDone = formProgress.detailsComplete;
  const submitDone = formProgress.submitted;
  const currentStep = submitDone ? 3 : detailsDone ? 3 : typeConfirmed ? 2 : 1;
  const blockedReason = !detailsDone
      ? `Complete the required fields to reach the final step: ${formProgress.missing.join(", ")}.`
      : undefined;
  const draftScope = draftScopeFor(pkg.slug, mode);
  const stepSlug = STEP_SLUGS[Math.min(currentStep, STEP_SLUGS.length - 1)];

  // Restore where the artist left off (track type + step) after hydration, so
  // a refresh or a later visit continues instead of restarting at step one.
  // A ?step= URL always wins so shared links land on the intended step.
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (search.step) return;
    const saved = readFlowState(pkg.slug);
    if (!saved) return;
    setTypeConfirmed(saved.typeConfirmed);
    if (saved.typeConfirmed) setResumedAt(saved.savedAt || Date.now());
  }, [pkg.slug, search.step]);

  // Mirror the live position into the URL so it can be copied or bookmarked.
  useEffect(() => {
    if (!restoredRef.current) return;
    if (search.step === stepSlug && search.mode === mode) return;
    navigate({
      to: "/start/$package",
      params: { package: pkg.slug },
      search: { step: stepSlug, mode },
      replace: true,
    });
  }, [navigate, pkg.slug, stepSlug, mode, search.step, search.mode]);

  // Keep the saved position in sync as the artist moves through the flow.
  useEffect(() => {
    if (!restoredRef.current) return;
    if (submitDone) {
      clearFlowState(pkg.slug);
      return;
    }
    if (!typeConfirmed) return;
    writeFlowState(pkg.slug, { mode, typeConfirmed, step: currentStep });
  }, [pkg.slug, mode, typeConfirmed, currentStep, submitDone]);


  // Funnel tracking: a step view fires when the step becomes current, and the
  // matching completion fires as soon as that step's requirements validate.
  useEffect(() => {
    trackFunnelEvent({
      event: "step_view",
      packageSlug: pkg.slug,
      step: stepSlug,
      stepIndex: currentStep,
      mode,
      currency,
    });
  }, [pkg.slug, stepSlug, currentStep, mode, currency]);

  useEffect(() => {
    trackFunnelEvent({
      event: "step_complete",
      packageSlug: pkg.slug,
      step: "package",
      stepIndex: 0,
      mode,
      currency,
    });
  }, [pkg.slug, mode, currency]);

  useEffect(() => {
    if (!typeConfirmed) return;
    trackFunnelEvent({
      event: "step_complete",
      packageSlug: pkg.slug,
      step: "track-type",
      stepIndex: 1,
      mode,
      currency,
    });
  }, [typeConfirmed, pkg.slug, mode, currency]);

  useEffect(() => {
    if (!detailsDone) return;
    trackFunnelEvent({
      event: "step_complete",
      packageSlug: pkg.slug,
      step: "track-details",
      stepIndex: 2,
      mode,
      currency,
    });
  }, [detailsDone, pkg.slug, mode, currency]);

  useEffect(() => {
    if (!submitDone) return;
    trackFunnelEvent({
      event: "step_complete",
      packageSlug: pkg.slug,
      step: "submit",
      stepIndex: 3,
      mode,
      currency,
    });
  }, [submitDone, pkg.slug, mode, currency]);

  const copyStepLink = async () => {
    try {
      const url = `${window.location.origin}/start/${pkg.slug}?step=${stepSlug}&mode=${mode}`;
      await navigator.clipboard.writeText(url);
      setLinkCopied(true);
      window.setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      setLinkCopied(false);
    }
  };

  const startPaidOrder = (reference: string, email: string) => {
    setPayNow(false);
    trackFunnelEvent(
      {
        event: "payment_initiated",
        packageSlug: pkg.slug,
        step: "submit",
        stepIndex: 3,
        mode,
        currency,
        reference,
        details: { priceId: pkg.priceIdSingle },
      },
      { once: false },
    );
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
          <Link
            to="/start"
            className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-primary"
          >
            ← All packages
          </Link>
        </div>
      </header>

      <section className="py-12 md:py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-10 flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <div className="eyebrow">
                <span className="text-[#e11d2e]">/ {pkg.n}</span>{" "}
                <span className="text-white">{pkg.tagline}</span>
              </div>
              <h1
                className="mt-4 font-display text-4xl font-bold leading-[1.02] tracking-tight sm:text-5xl"
                style={{ color: pkg.color }}
              >
                {pkg.title}
              </h1>
            </div>
            <CurrencySwitcher />
          </div>

          <FlowProgress steps={FLOW_STEPS} current={currentStep} blockedReason={blockedReason} className="mb-3" />

          <div className="mb-8 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span className="font-mono">?step={stepSlug}&amp;mode={mode}</span>
            <button
              type="button"
              onClick={copyStepLink}
              className="border border-border-strong px-3 py-1.5 font-semibold uppercase tracking-widest text-white transition-colors hover:border-[#4b8bff] hover:text-[#4b8bff]"
            >
              {linkCopied ? "Link copied" : "Copy link to this step"}
            </button>
          </div>


          {resumedAt && !resumeDismissed && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-[#4b8bff]/50 bg-[#4b8bff]/10 px-4 py-3 text-sm text-white">
              <span>
                Picked up where you left off — single track, step {Math.min(currentStep + 1, FLOW_STEPS.length)} of {FLOW_STEPS.length}. Your saved
                details are already filled in.
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    clearFlowState(pkg.slug);
                    setResumedAt(null);
                  }}
                  className="text-xs font-semibold uppercase tracking-widest text-[#8fb6ff] hover:text-white"
                >
                  Start over
                </button>
                <button
                  type="button"
                  onClick={() => setResumeDismissed(true)}
                  className="text-xs font-semibold uppercase tracking-widest text-muted-foreground hover:text-white"
                >
                  Dismiss
                </button>
              </span>
            </div>
          )}

          <DraftResumeBanner
            slug={pkg.slug}
            activeScope={draftScope}
            onResume={() => {
              setTypeConfirmed(true);
            }}
          />

          <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">

            {/* Package summary + actions */}
            <aside className="flex h-fit flex-col gap-5 border border-border-strong bg-background/30 p-7 backdrop-blur-sm lg:sticky lg:top-24">
              <div className="border-b border-border/60 pb-4">
                <div className="font-display text-3xl font-bold text-white">{singlePrice} / track</div>
              </div>

              <PriceBreakdown
                priceId={pkg.priceIdSingle}
                currency={currency}
                label="Single track"
              />

              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-[#e11d2e]">You bring</dt>
                  <dd className="mt-1 text-muted-foreground">{pkg.bring}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-white">We do</dt>
                  <dd className="mt-1 text-muted-foreground">{pkg.do}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wider text-[#4b8bff]">You get</dt>
                  <dd className="mt-1 text-muted-foreground">{pkg.get}</dd>
                </div>
              </dl>

              {pkg.startOptions?.length ? (
                <PackageStartOptions pkg={pkg} className="-mx-7 border-y border-border/60 px-7 pt-5" />
              ) : null}


              <button
                type="button"
                onClick={() => setPayNow(true)}
                className="w-full border border-[#4b8bff] bg-[#4b8bff]/10 px-4 py-3 text-sm font-semibold uppercase tracking-widest text-[#4b8bff] transition-all hover:bg-[#4b8bff] hover:text-black hover:shadow-[0_0_28px_-4px_rgba(75,139,255,0.85)]"
              >
                Pay Now — Single Track ({singlePrice})
              </button>

              <p className="text-xs text-muted-foreground">
                Every order covers one single track on this package.
              </p>
            </aside>

            {/* Inline application form */}
            <div>
              <h2 className="mb-4 font-display text-xl font-semibold text-white">
                Single-track application
              </h2>
              <ApplicationModal
                key={`${pkg.slug}-${mode}`}
                inline
                open
                draftScope={draftScope}
                onClose={() => {}}
                onProgressChange={setFormProgress}
                defaultPackage={pkg.applySingle}
              />
            </div>
          </div>
        </div>
      </section>

      {payNow && (
        <PayNowModal
          open
          packageLabel={pkg.title}
          priceLabel={singlePrice}
          priceId={pkg.priceIdSingle}
          currency={currency}
          onClose={() => setPayNow(false)}
          onSubmitted={({ reference, email }) => startPaidOrder(reference, email)}
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
            <div className="border-b border-black/10 bg-neutral-50 px-6 py-4 text-black">
              <PriceBreakdown
                priceId={pkg.priceIdSingle}
                currency={currency}
                label="Single track"
                className="border-black/10 bg-white [&_dd]:text-black [&_dt]:text-neutral-600 [&_p]:text-neutral-600"
              />
            </div>
            {checkoutElement}
          </div>
        </div>
      )}
    </div>
  );
}
