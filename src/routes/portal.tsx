import { useEffect, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
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

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

import { ApplicationModal } from "@/components/ApplicationModal";
import { ContactModal } from "@/components/ContactModal";
import { OrderIntakeSection } from "@/components/OrderIntakeSection";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { StudioErrorBoundary } from "@/components/StudioErrorBoundary";
import { LocaleCluster } from "@/components/SiteNav";
import { pageHead } from "@/lib/social-meta";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { SERVICES, VIDEO_SERVICES } from "@/lib/services";
import { buildPageJsonLd } from "@/lib/release-schema";

/** Legacy `?view=` values redirect to their standalone destinations. */
const portalSearchSchema = z
  .object({
    view: z.enum(["tokens", "studio", "services"]).optional(),
    package: z.string().optional(),
    resume: z.string().optional(),
    artist: z.string().optional(),
    email: z.string().optional(),
    demo: z.string().optional(),
  })
  .passthrough();

export const Route = createFileRoute("/portal")({
  validateSearch: portalSearchSchema,
  beforeLoad: ({ search }) => {
    if (search.view === "studio") {
      throw redirect({ to: "/engine" });
    }
    if (search.view === "tokens") {
      throw redirect({ to: "/tokens" });
    }
  },
  head: () => ({
    ...pageHead({
      path: "/portal",
      title: "Distribution & Video Packages — Hybrid AI Records",
      description:
        "Project intake for distribution-only rollouts and music video production. Flat fees, clear delivery requirements, and a live application form.",
      socialTitle: "Distribution & Video Packages — Hybrid AI Records",
      socialDescription:
        "Apply for distribution and video packages. Project intake is open.",
      type: "website",
      card: "summary_large_image",
    }),
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify(
          buildPageJsonLd({
            path: "/portal",
            name: "Distribution & Video Packages — Hybrid AI Records",
            description:
              "Project intake for distribution-only rollouts and music video production packages.",
            breadcrumb: [{ name: "Distribution & Video Packages", path: "/portal" }],
          }),
        ),
      },
    ],
  }),
  errorComponent: RouteErrorFallback,
  component: DistributionPackagesPage,
});

const SERVICE_STATUS = {
  available: [
    "Project intake / application forms",
    "Distribution-only packages",
    "Music video production packages",
  ],
};

function DistributionPackagesPage() {
  const [applyPackage, setApplyPackage] = useState<string | null>(null);
  const [contactOpen, setContactOpen] = useState(false);

  // Secure resume links (?resume=<token>) open the application modal on this page only.
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("resume");
    if (token) setApplyPackage("foundation_single");
  }, []);

  return (
    <StudioErrorBoundary region="portal">
    <div className="min-h-dvh">
      <main id="main-content" className="mx-auto max-w-5xl px-4 pb-24 pt-8 sm:px-6 md:pt-12">
        <PortalBreadcrumb
          trail={[{ label: "Distribution & Video Packages" }]}
          end={<LocaleCluster className="hidden lg:inline-flex" />}
        />

        <div className="eyebrow">
          <span className="text-[#e11d2e]">/ Distribution</span>{" "}
          <span className="text-white">& Video</span>
        </div>
        <h1 className="mt-4 font-display text-4xl font-bold leading-[1.02] tracking-tight text-white sm:text-5xl">
          Project intake is open. Distribution & video packages are live.
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          We are actively accepting applications for distribution-only rollouts and music video
          production.
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
                      <p className="mt-2 max-w-2xl text-base text-muted-foreground">{dist.tagline}</p>
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
              <h3 className="font-display text-xl font-semibold text-white">
                Not sure which package fits?
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Submit a general project intake and we will route you to distribution, video, or the
                Hybrid Engine 1.0 Alpha based on what you actually need.
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

        <div className="mt-14">
          <OrderIntakeSection />
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
    </StudioErrorBoundary>
  );
}
