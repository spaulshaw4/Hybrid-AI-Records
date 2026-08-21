import { CalendarClock } from "lucide-react";
import { purchaseDeliveryRange } from "@/lib/purchase-delivery";
import { formatDeliveryDate } from "@/lib/delivery-estimate";

/**
 * Shows the estimated delivery window as real calendar dates, counted in
 * business days from the purchase date.
 */
export function DeliveryDateRange({
  slug,
  purchasedAt,
  purchaseLabel = "purchase date",
  className = "",
}: {
  slug: string;
  purchasedAt: Date;
  purchaseLabel?: string;
  className?: string;
}) {
  const range = purchaseDeliveryRange(slug, purchasedAt);

  return (
    <div className={`border border-border bg-background/40 p-4 text-start backdrop-blur-sm ${className}`}>
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
        Estimated delivery
      </span>
      <p className="mt-2 flex items-start gap-2 text-sm font-semibold leading-relaxed text-white">
        <CalendarClock size={16} aria-hidden className="mt-[2px] flex-none text-[#4b8bff]" />
        <span>
          <time dateTime={range.earliest.toISOString()}>{formatDeliveryDate(range.earliest)}</time>
          {" – "}
          <time dateTime={range.latest.toISOString()}>{formatDeliveryDate(range.latest)}</time>
        </span>
      </p>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {range.countLabel} from your {purchaseLabel} ({formatDeliveryDate(purchasedAt)}). Business
        days only — weekends don't count. Late or incomplete assets push the window out.
      </p>
    </div>
  );
}
