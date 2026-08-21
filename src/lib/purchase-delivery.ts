/**
 * Turns a purchased package into real calendar dates instead of a bare
 * "10–14 business days" count. Everything is business-day math (Mon–Fri),
 * counted from the purchase date.
 */
import { addBusinessDays, formatDeliveryDate } from "@/lib/delivery-estimate";
import { SERVICES, VIDEO_SERVICES, type ServicePackage } from "@/lib/services";

/** sessionStorage key holding the last checkout's package + purchase timestamp. */
export const PURCHASE_DELIVERY_STORAGE_KEY = "hybrid:last-checkout-delivery";

export type StoredPurchase = { slug: string; purchasedAt: string };

/** Business-day windows per package slug, counted from purchase. */
const WINDOW_BY_SLUG: Record<string, { minDays: number; maxDays: number }> = {
  foundation: { minDays: 2, maxDays: 4 },
  "visual-push": { minDays: 5, maxDays: 10 },
  "full-hybrid": { minDays: 7, maxDays: 14 },
  "standard-video": { minDays: 10, maxDays: 14 },
  "4k-hd-video": { minDays: 14, maxDays: 21 },
};

const DEFAULT_WINDOW = { minDays: 5, maxDays: 7 };

export type PurchaseDeliveryRange = {
  minDays: number;
  maxDays: number;
  earliest: Date;
  latest: Date;
  /** "Mon, Aug 17, 2026 – Fri, Aug 21, 2026" */
  rangeLabel: string;
  /** "10–14 business days" */
  countLabel: string;
};

/** Calculates the delivery date range for a package bought on `purchasedAt`. */
export function purchaseDeliveryRange(
  slug: string,
  purchasedAt: Date = new Date(),
): PurchaseDeliveryRange {
  const window = WINDOW_BY_SLUG[slug] ?? DEFAULT_WINDOW;
  const earliest = addBusinessDays(purchasedAt, window.minDays);
  const latest = addBusinessDays(purchasedAt, window.maxDays);
  return {
    ...window,
    earliest,
    latest,
    rangeLabel: `${formatDeliveryDate(earliest)} – ${formatDeliveryDate(latest)}`,
    countLabel: `${window.minDays}–${window.maxDays} business days`,
  };
}

/** Looks up a package by slug across the audio and video pipelines. */
export function packageBySlug(slug: string): ServicePackage | undefined {
  return [...SERVICES, ...VIDEO_SERVICES].find((s) => s.slug === slug);
}

/** Records the package + purchase moment so the confirmation page can date it. */
export function rememberPurchaseForDelivery(slug: string, purchasedAt: Date = new Date()) {
  try {
    window.sessionStorage.setItem(
      PURCHASE_DELIVERY_STORAGE_KEY,
      JSON.stringify({ slug, purchasedAt: purchasedAt.toISOString() } satisfies StoredPurchase),
    );
  } catch {
    /* storage unavailable — the range still renders in the portal review step */
  }
}

/** Reads back the stored purchase, or null when nothing usable is saved. */
export function readStoredPurchase(): StoredPurchase | null {
  try {
    const raw = window.sessionStorage.getItem(PURCHASE_DELIVERY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPurchase>;
    if (typeof parsed?.slug !== "string" || typeof parsed?.purchasedAt !== "string") return null;
    if (Number.isNaN(new Date(parsed.purchasedAt).getTime())) return null;
    return { slug: parsed.slug, purchasedAt: parsed.purchasedAt };
  } catch {
    return null;
  }
}
