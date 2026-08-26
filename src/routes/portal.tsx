import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { z } from "zod";
import {
  Check,
  ArrowUpRight,
  Film,
  FileText,
  MessageCircle,
  Shield,
  Sparkles,
} from "lucide-react";


import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";


import { AudioStudio } from "@/components/AudioStudio";
import { HybridTokenIcon } from "@/components/HybridTokenIcon";
import { ApplicationModal } from "@/components/ApplicationModal";
import { ContactModal } from "@/components/ContactModal";

import { pageHead } from "@/lib/social-meta";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { Wordmark } from "@/components/Wordmark";
import { TokenStore } from "@/components/TokenStore";
import { TOKEN_BUNDLES, perTokenLabel, usdLabel } from "@/lib/tokens";
import { SERVICES, VIDEO_SERVICES, type ServicePackage } from "@/lib/services";
import { buildPageJsonLd } from "@/lib/release-schema";


const portalSearchSchema = z.object({
  view: z.enum(["tokens", "studio", "services"]).optional(),
});


export const Route = createFileRoute("/portal")({
  validateSearch: portalSearchSchema,
  head: () => ({
    ...pageHead({
      path: "/portal",
      title: "Hybrid Tokens — Hybrid AI Records",
      description:
        "Buy Hybrid Tokens and generate single tracks in the Hybrid Engine 1.0 Alpha. One balance, one engine, no packages or bundles.",
      socialTitle: "Hybrid Tokens — Hybrid AI Records",
      socialDescription:
        "Top up your Hybrid Token balance and generate single tracks in the engine.",
      type: "website",
      card: "summary_large_image",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/portal",
            name: "Project Portal — Hybrid AI Records",
            description:
              "Buy Hybrid Tokens, generate single tracks in the Hybrid Engine 1.0 Alpha, and manage distribution and video services.",
            breadcrumb: [{ name: "Project Portal", path: "/portal" }],
          }),
        ),
      },
    ],
  }),

  errorComponent: RouteErrorFallback,
  component: ProjectPortal,
});

const HOW_IT_WORKS = [
  "Buy a Hybrid Token bundle — tokens never expire.",
  "Open the engine and write your prompt and lyrics.",
  "Generate a single track and play it right on the page.",
];

const SERVICE_STATUS = {
  available: [
    "Project intake / application forms",
    "Distribution-only packages",
    "Music video production packages",
  ],
};

function ProjectPortal() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // Local state drives the instant switch; the URL mirrors it so the view is
  // shareable. Both panels stay mounted, so the session and any in-flight
  // generation survive tab switches.
  const [view, setView] = useState<"tokens" | "studio" | "services">(search.view ?? "tokens");
  const [applyPackage, setApplyPackage] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  function selectView(next: "tokens" | "studio" | "services") {
    setView(next);
    void navigate({ to: "/portal", search: { view: next }, replace: true });
  }



  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-3 sm:flex sm:justify-between sm:gap-4 sm:px-6 sm:py-4">
          <Link to="/" aria-label="Hybrid AI Records home" className="min-w-0">
            <Wordmark size="md" interactive />
          </Link>
          <div className="flex shrink-0 items-center gap-2 sm:gap-4">
            <TokenStore />
          </div>
        </div>
      </header>

      <main id="main-content" className="mx-auto max-w-5xl px-4 pb-24 pt-8 sm:px-6 md:pt-16">
        <PortalBreadcrumb
          trail={[
            {
              label:
                view === "tokens"
                  ? "Tokens"
                  : view === "studio"
                    ? "Hybrid Engine 1.0 Alpha"
                    : "Distribution & Video",
            },
          ]}
        />


        <div
          role="tablist"
          aria-label="Portal workspace"
          className="-mx-4 mb-8 flex gap-px overflow-x-auto bg-border/60 px-4 sm:mx-0 sm:inline-flex sm:px-0"
        >
          {(["tokens", "studio", "services"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => selectView(tab)}
              className={`min-h-11 shrink-0 px-4 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] transition-colors sm:px-6 ${
                view === tab
                  ? "bg-[#e11d2e] text-white"
                  : "bg-background/40 text-muted-foreground hover:text-white"
              }`}
            >
              {tab === "tokens" ? "Tokens" : tab === "studio" ? "Hybrid Engine 1.0 Alpha" : "Distribution & Video"}
            </button>
          ))}
        </div>

        <div hidden={view !== "services"}>

          <div className="eyebrow">
            <span className="text-[#e11d2e]">/ Distribution</span>{" "}
            <span className="text-white">& Video</span>
          </div>
          <h1 className="mt-4 font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-5xl">
            Project intake is open. Distribution & video packages are live.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            We are actively accepting applications for distribution-only rollouts and music video production.
          </p>

          <div className="mt-10 grid grid-cols-1 gap-px bg-border/60 md:grid-cols-1">
            <div className="bg-background/40 p-8 backdrop-blur-sm">
              <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-emerald-400">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                </span>
                Currently Available
              </div>
              <ul className="mt-6 space-y-3">
                {SERVICE_STATUS.available.map((item) => (
                  <li key={item} className="flex gap-2 text-sm text-white/80">
                    <Check size={14} aria-hidden className="mt-0.5 flex-none text-emerald-400" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <section aria-labelledby="portal-packages" className="mt-14">
            <h2
              id="portal-packages"
              className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
            >
              01 — Distribution & Video Packages
            </h2>

            {/* Enterprise Distribution card — full-width, high-converting */}
            <div className="mt-6">
              {SERVICES.filter((s) => s.kind === "distribution").map((dist) => (
                <div
                  key={dist.slug}
                  className="group relative overflow-hidden rounded-lg border border-border bg-background/40 backdrop-blur-sm transition-colors hover:border-primary/60"
                >
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#e11d2e] via-[#c4162a] to-[#e11d2e]" />
                  <div className="p-8 md:p-10">
                    <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center gap-3">
                          {dist.badge && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#e11d2e]/30 bg-[#e11d2e]/10 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-[#e11d2e]">
                              <Shield size={12} aria-hidden />
                              {dist.badge}
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                            <Sparkles size={12} aria-hidden />
                            Distribution
                          </span>
                        </div>
                        <h3 className="mt-4 font-display text-3xl font-bold text-white md:text-4xl">
                          {dist.title}
                        </h3>
                        <p className="mt-2 max-w-2xl text-base text-muted-foreground">
                          {dist.tagline}
                        </p>
                      </div>
                      <div className="md:text-right">
                        <p className="font-display text-4xl font-bold text-white">{dist.priceSingle}</p>
                        <p className="mt-1 text-xs text-muted-foreground">Flat one-time fee</p>
                      </div>
                    </div>

                    <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
                      {(dist.features ?? dist.highlights).map((feature) => (
                        <div
                          key={feature}
                          className="flex gap-3 rounded-md border border-white/5 bg-white/[0.02] p-4"
                        >
                          <Check
                            size={18}
                            aria-hidden
                            className="mt-0.5 flex-none text-emerald-400"
                          />
                          <span className="text-sm leading-relaxed text-white/80">{feature}</span>
                        </div>
                      ))}
                    </div>

                    {dist.deliveryRequirements && (
                      <div className="mt-6">
                        <Accordion type="single" collapsible className="w-full">
                          <AccordionItem value="delivery-requirements" className="border-border/60">
                            <AccordionTrigger className="text-sm text-muted-foreground hover:text-white hover:no-underline">
                              View Delivery Requirements
                            </AccordionTrigger>
                            <AccordionContent>
                              <div className="grid grid-cols-1 gap-4 pt-2 md:grid-cols-2">
                                <div className="rounded-md border border-white/5 bg-white/[0.02] p-4">
                                  <p className="text-sm font-medium text-white">Audio Format</p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    {dist.deliveryRequirements.audioFormat}
                                  </p>
                                </div>
                                <div className="rounded-md border border-white/5 bg-white/[0.02] p-4">
                                  <p className="text-sm font-medium text-white">Cover Artwork</p>
                                  <p className="mt-1 text-sm text-muted-foreground">
                                    {dist.deliveryRequirements.coverArt}
                                  </p>
                                </div>
                              </div>
                            </AccordionContent>
                          </AccordionItem>
                        </Accordion>
                      </div>
                    )}

                    <div className="mt-8">
                      <button
                        type="button"
                        onClick={() => setApplyPackage(dist.applySingle)}
                        className="inline-flex w-full items-center justify-center gap-2 bg-[#e11d2e] px-8 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a] md:w-auto"
                      >
                        Distribute Your Track ($25)
                        <ArrowUpRight size={14} aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Video production cards */}
            <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-2">
              {VIDEO_SERVICES.map((pkg) => (
                <div
                  key={pkg.slug}
                  className="flex flex-col gap-4 border border-border bg-background/40 p-6 backdrop-blur-sm transition-colors hover:border-primary/60"
                >
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                    <Film size={14} />
                    <span>Video Production</span>
                  </div>
                  <div>
                    <h3 className="font-display text-xl font-semibold text-white">{pkg.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{pkg.tagline}</p>
                  </div>
                  <p className="font-display text-3xl font-bold text-white">{pkg.priceSingle}</p>
                  <ul className="flex-1 space-y-2">
                    {pkg.highlights.slice(0, 3).map((h) => (
                      <li key={h} className="flex gap-2 text-sm text-white/80">
                        <Check size={14} aria-hidden className="mt-0.5 flex-none text-emerald-400" />
                        <span>{h}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1 text-xs leading-relaxed text-amber-400/90">
                    Video shoots require an appointment. Contact us to schedule your date and location.
                  </p>
                  <button
                    type="button"
                    onClick={() => setContactOpen(true)}
                    className="mt-2 inline-flex w-full items-center justify-center gap-2 bg-[#e11d2e] px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a]"
                  >
                    <MessageCircle size={14} aria-hidden />
                    Contact us
                  </button>
                </div>
              ))}
            </div>
          </section>


          <section aria-labelledby="portal-intake" className="mt-14 border-t border-border pt-10">
            <h2
              id="portal-intake"
              className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
            >
              02 — General Project Intake
            </h2>
            <div className="mt-6 flex flex-col gap-6 border border-border bg-background/40 p-8 backdrop-blur-sm md:flex-row md:items-center md:justify-between">
              <div className="max-w-xl">
                <h3 className="font-display text-xl font-semibold text-white">Not sure which package fits?</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Submit a general project intake and we will route you to distribution, video, or the Hybrid Engine 1.0 Alpha based on what you actually need.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setApplyPackage("foundation_single")}
                className="inline-flex shrink-0 items-center gap-2 border border-white/15 bg-white/[0.03] px-6 py-3 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white/75 transition-all hover:border-white/35 hover:bg-white/[0.07] hover:text-white"
              >
                <FileText size={14} />
                Open intake form
              </button>
            </div>
          </section>
        </div>


        <div hidden={view !== "studio"}>
          <h1 className="font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-5xl">
            Hybrid Engine 1.0 Alpha
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Write your concept, pick a style, choose vocals or instrumental — your mastered track
            appears right underneath.
          </p>
          <div className="mt-8">
            <AudioStudio />
          </div>
        </div>

        <div hidden={view !== "tokens"}>
        <div className="eyebrow">
          <span className="text-[#e11d2e]">/ Hybrid</span>{" "}
          <span className="text-white">Tokens —</span>{" "}
          <span className="text-[#4b8bff]">One balance, one engine</span>
        </div>
        <h1 className="mt-4 font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-5xl">
          Buy tokens. Generate single tracks.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          No packages, no bundles, no video pipelines. Hybrid Tokens power every single-track
          generation in the engine — buy once and spend them whenever you want.
        </p>

        <section aria-labelledby="portal-bundles" className="mt-14">
          <h2
            id="portal-bundles"
            className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
          >
            01 — Token bundles
          </h2>

          <div className="mt-6 grid grid-cols-1 gap-px bg-border/60 sm:grid-cols-3">
            {TOKEN_BUNDLES.map((bundle) => (
              <div
                key={bundle.priceId}
                className="flex flex-col gap-3 bg-background/40 p-8 backdrop-blur-sm"
              >
                <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  {bundle.name}
                </span>
                <span className="font-display text-3xl font-bold text-white">
                  {usdLabel(bundle.amount)}
                </span>
                <span className="inline-flex items-center gap-1.5 text-sm text-[#e11d2e]">
                  <HybridTokenIcon className="h-[15px] w-[15px] text-[10px]" />
                  {bundle.tokens} Hybrid Tokens
                </span>
                <span className="text-xs text-muted-foreground">
                  {bundle.bonus > 0
                    ? `Includes ${bundle.bonus} bonus tokens`
                    : perTokenLabel(bundle)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Use the <span className="text-white">Buy Tokens</span> button above to check out — tokens
            land on your balance as soon as payment clears.
          </p>
        </section>

        <section aria-labelledby="portal-how" className="mt-16 border-t border-border pt-10">
          <h2
            id="portal-how"
            className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground"
          >
            02 — How it works
          </h2>
          <ul className="mt-6 space-y-3 text-sm text-white/80">
            {HOW_IT_WORKS.map((step) => (
              <li key={step} className="flex gap-3">
                <Check size={16} aria-hidden className="mt-0.5 flex-none text-[#e11d2e]" />
                <span>{step}</span>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() => selectView("studio")}
            className="mt-8 inline-flex items-center gap-2 bg-[#e11d2e] px-8 py-4 font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#c4162a]"
          >
            Open the engine
            <ArrowUpRight size={14} aria-hidden />
          </button>
        </section>
        </div>
      </main>

      {applyPackage && (
        <ApplicationModal
          open={true}
          onClose={() => setApplyPackage(null)}
          defaultPackage={applyPackage}
        />
      )}

      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </div>
  );
}
