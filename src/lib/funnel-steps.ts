/** Shared funnel step definitions and result types (no server-only code). */
export const FUNNEL_STEPS = [
  { slug: "package", label: "Package" },
  { slug: "track-type", label: "Track type" },
  { slug: "track-details", label: "Your details" },
  { slug: "submit", label: "Submit or pay" },
] as const;

export type FunnelStepStat = {
  slug: string;
  label: string;
  views: number;
  completions: number;
  dropOffPct: number;
};

export type FunnelSummary = {
  windowDays: number;
  packageSlug: string | null;
  visitors: number;
  steps: FunnelStepStat[];
  paymentsInitiated: number;
  packages: string[];
};
