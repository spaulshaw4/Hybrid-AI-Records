/**
 * Expected delivery windows for an order, derived from the package the artist
 * bought. Business days only — weekends never count toward a turnaround
 * promise, so the dates here match what the team quotes on the phone.
 */

export type DeliveryWindow = {
  /** Package-facing label, e.g. "5–10 business days". */
  label: string;
  minDays: number;
  maxDays: number;
  /** What the artist actually receives at the end of the window. */
  deliverable: string;
};

const WINDOWS: { match: RegExp; window: DeliveryWindow }[] = [
  {
    match: /foundation/i,
    window: {
      label: "2–4 business days",
      minDays: 2,
      maxDays: 4,
      deliverable: "Distribution submitted to Spotify, Apple Music, and the global stores.",
    },
  },
  {
    match: /visual\s*push/i,
    window: {
      label: "5–10 business days",
      minDays: 5,
      maxDays: 10,
      deliverable: "Mixed & mastered track plus your Standard HD music video.",
    },
  },
  {
    match: /full\s*hybrid/i,
    window: {
      label: "7–14 business days",
      minDays: 7,
      maxDays: 14,
      deliverable: "Full production, 4K cinematic video, and release-ready masters.",
    },
  },
];

const DEFAULT_WINDOW: DeliveryWindow = {
  label: "5–7 business days",
  minDays: 5,
  maxDays: 7,
  deliverable: "Release-ready masters delivered to your inbox.",
};

/** Picks the turnaround window for a stored package label. */
export function deliveryWindowFor(packageLabel: string): DeliveryWindow {
  return WINDOWS.find((w) => w.match.test(packageLabel))?.window ?? DEFAULT_WINDOW;
}

/** Adds N business days (Mon–Fri) to a date. */
export function addBusinessDays(start: Date, days: number): Date {
  const date = new Date(start.getTime());
  let remaining = days;
  while (remaining > 0) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date;
}

/** Business days between two dates, never negative. */
export function businessDaysBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  const cursor = new Date(from.getTime());
  let count = 0;
  while (cursor < to) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

export type DeliveryEstimate = {
  window: DeliveryWindow;
  /** When the clock started: payment date when paid, otherwise submission. */
  startedAt: Date;
  startLabel: string;
  earliest: Date;
  latest: Date;
  /** Business days left until the far end of the window (0 when due/past). */
  businessDaysRemaining: number;
  /** True once the latest date has passed and nothing is delivered yet. */
  overdue: boolean;
  delivered: boolean;
};

/** Builds the full estimate shown on the order status page. */
export function deliveryEstimate(input: {
  packageLabel: string;
  createdAt: string;
  paidAt: string | null;
  status: string;
  now?: Date;
}): DeliveryEstimate {
  const now = input.now ?? new Date();
  const window = deliveryWindowFor(input.packageLabel);
  const startedAt = new Date(input.paidAt ?? input.createdAt);
  const delivered = input.status === "delivered";
  const earliest = addBusinessDays(startedAt, window.minDays);
  const latest = addBusinessDays(startedAt, window.maxDays);

  return {
    window,
    startedAt,
    startLabel: input.paidAt ? "payment confirmed" : "submission received",
    earliest,
    latest,
    businessDaysRemaining: businessDaysBetween(now, latest),
    overdue: !delivered && now > latest,
    delivered,
  };
}

/** Long date, no time — delivery promises are day-level, not hour-level. */
export function formatDeliveryDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Rounds included with every package before extra rounds are quoted. */
export const INCLUDED_REVISION_ROUNDS = 2;
