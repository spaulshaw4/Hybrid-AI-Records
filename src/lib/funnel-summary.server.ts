/** Pure aggregation helper for funnel events (server-side only). */
import { FUNNEL_STEPS, type FunnelStepStat, type FunnelSummary } from "@/lib/funnel-steps";

export type RawFunnelEvent = {
  event: string;
  package_slug: string | null;
  step: string | null;
  visitor_session: string;
};

export function summarizeFunnel(
  rows: RawFunnelEvent[],
  windowDays: number,
  packageSlug: string | null,
): FunnelSummary {
  const events = rows.filter((row) => !packageSlug || row.package_slug === packageSlug);

  const packages = [
    ...new Set(rows.map((r) => r.package_slug).filter((s): s is string => !!s)),
  ].sort();

  const visitors = new Set(events.map((e) => e.visitor_session)).size;
  const uniq = (event: string, step: string) =>
    new Set(
      events.filter((e) => e.event === event && e.step === step).map((e) => e.visitor_session),
    ).size;

  const steps: FunnelStepStat[] = FUNNEL_STEPS.map((step) => {
    const views = uniq("step_view", step.slug);
    const completions = uniq("step_complete", step.slug);
    return {
      slug: step.slug,
      label: step.label,
      views,
      completions,
      dropOffPct: views === 0 ? 0 : Math.round(((views - completions) / views) * 1000) / 10,
    };
  });

  const paymentsInitiated = new Set(
    events.filter((e) => e.event === "payment_initiated").map((e) => e.visitor_session),
  ).size;

  return { windowDays, packageSlug, visitors, steps, paymentsInitiated, packages };
}
