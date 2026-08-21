/**
 * Click analytics for the "See how it works — 3 steps" anchor CTA on each
 * service card. Every click is recorded as a `cta_click` funnel event tagged
 * with the originating package slug so staff can see which service drives the
 * most scrolls to the process section.
 */
import { trackFunnelEvent, visitorSessionId } from "@/lib/funnel-analytics";

export const HOW_IT_WORKS_CTA_ID = "how_it_works_anchor";

/** Step tag stored on the funnel event (must stay <= 32 chars for the RLS check). */
export const HOW_IT_WORKS_STEP = "how-it-works";

export type HowItWorksCtaClick = {
  /** Service/package slug the CTA belongs to, e.g. "foundation". */
  packageSlug: string;
  /** Human-readable service title, for the admin readout. */
  serviceTitle: string;
  /** Where the CTA lives, e.g. "service-card". */
  placement?: string;
};

/**
 * Records one CTA click. Fire-and-forget: never blocks or breaks the scroll.
 * De-duplication is disabled so repeat clicks are counted individually.
 */
export function trackHowItWorksCtaClick(input: HowItWorksCtaClick) {
  trackFunnelEvent(
    {
      event: "cta_click",
      packageSlug: input.packageSlug,
      step: HOW_IT_WORKS_STEP,
      details: {
        cta: HOW_IT_WORKS_CTA_ID,
        service_title: input.serviceTitle,
        placement: input.placement ?? "service-card",
        session: visitorSessionId(),
      },
    },
    { once: false },
  );
}
