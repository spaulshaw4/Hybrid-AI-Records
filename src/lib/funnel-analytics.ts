/**
 * Funnel event tracking for the /start application flow.
 *
 * Three event types are recorded so drop-off across the four steps can be
 * measured: `step_view` (a step became visible), `step_complete` (the required
 * fields for that step validated) and `payment_initiated` (Stripe checkout was
 * opened). Events are written to `public.funnel_events` and also forwarded to
 * gtag/PostHog when either is present on the page.
 */
import { supabase } from "@/integrations/supabase/client";

export type FunnelEventName = "step_view" | "step_complete" | "payment_initiated" | "cta_click";

export type FunnelEventInput = {
  event: FunnelEventName;
  packageSlug?: string | null;
  step?: string | null;
  stepIndex?: number | null;
  mode?: "single" | "bundle" | null;
  currency?: string | null;
  reference?: string | null;
  details?: Record<string, unknown>;
};

const SESSION_KEY = "har_funnel_session";

/** Stable per-tab visitor id — no personal data, just a funnel correlation key. */
export function visitorSessionId(): string {
  if (typeof window === "undefined") return "server";
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    window.sessionStorage.setItem(SESSION_KEY, id);
    return id;
  } catch {
    return `s_${Date.now().toString(36)}`;
  }
}

type Gtag = (command: string, event: string, params?: Record<string, unknown>) => void;
type PostHog = { capture: (event: string, params?: Record<string, unknown>) => void };

function forwardToProviders(input: FunnelEventInput) {
  if (typeof window === "undefined") return;
  const params = {
    package: input.packageSlug ?? undefined,
    step: input.step ?? undefined,
    step_index: input.stepIndex ?? undefined,
    mode: input.mode ?? undefined,
    currency: input.currency ?? undefined,
    reference: input.reference ?? undefined,
    ...(input.details ?? {}),
  };
  const w = window as unknown as { gtag?: Gtag; posthog?: PostHog };
  try {
    w.gtag?.("event", input.event, params);
  } catch {
    /* analytics must never break the flow */
  }
  try {
    w.posthog?.capture(input.event, params);
  } catch {
    /* ignore */
  }
}

// Fire-and-forget de-duplication so a re-render can't inflate step views.
const seen = new Set<string>();

export function trackFunnelEvent(input: FunnelEventInput, options?: { once?: boolean }) {
  if (typeof window === "undefined") return;
  const key = `${input.event}:${input.packageSlug ?? ""}:${input.step ?? ""}:${input.mode ?? ""}`;
  if (options?.once !== false) {
    if (seen.has(key)) return;
    seen.add(key);
  }

  forwardToProviders(input);

  void supabase
    .from("funnel_events")
    .insert({
      event: input.event,
      package_slug: input.packageSlug ?? null,
      step: input.step ?? null,
      step_index: input.stepIndex ?? null,
      mode: input.mode ?? null,
      currency: input.currency ?? null,
      reference: input.reference ?? null,
      visitor_session: visitorSessionId(),
      details: (input.details ?? {}) as never,
    })
    .then(({ error }) => {
      if (error) console.warn("[funnel] event not recorded:", error.message);
    });
}

/** Clears the de-dup cache — used when a visitor restarts the flow. */
export function resetFunnelDedupe() {
  seen.clear();
}
