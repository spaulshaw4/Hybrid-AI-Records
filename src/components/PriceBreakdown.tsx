import { useMoneyFormat } from "@/lib/money-format";
import {
  PACKAGE_PRICES,
  amountFor,
  surchargeAmountFor,
  surchargePercent,
  type CurrencyCode,
} from "@/lib/pricing";

type Props = {
  priceId: string;
  currency: CurrencyCode;
  /** Optional label for the base line (defaults to the package name). */
  label?: string;
  className?: string;
};

/**
 * Itemised base price + processing surcharge, matching exactly what Stripe
 * will bill. Renders a single total line for USD (no surcharge).
 */
export function PriceBreakdown({ priceId, currency, label, className }: Props) {
  const { format: formatAmount } = useMoneyFormat();
  const entry = PACKAGE_PRICES[priceId];
  const total = amountFor(priceId, currency);
  const surcharge = surchargeAmountFor(priceId, currency);
  if (!entry || total === null || surcharge === null) return null;


  const base = entry.amounts[currency];
  const pct = surchargePercent(currency);

  return (
    <dl
      className={`space-y-2 border border-border/60 bg-background/40 p-4 text-sm ${className ?? ""}`}
      aria-label="Price breakdown"
    >
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-muted-foreground">{label ?? entry.name}</dt>
        <dd className="font-medium text-white">{formatAmount(base, currency)}</dd>
      </div>

      {surcharge > 0 && (
        <div className="flex items-baseline justify-between gap-4">
          <dt className="text-muted-foreground">
            International processing fee ({pct}%)
          </dt>
          <dd className="font-medium text-white">{formatAmount(surcharge, currency)}</dd>
        </div>
      )}

      <div className="flex items-baseline justify-between gap-4 border-t border-border/60 pt-2">
        <dt className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Total due today
        </dt>
        <dd className="font-display text-lg font-bold text-white">
          {formatAmount(total, currency)}
        </dd>
      </div>

      {surcharge > 0 && (
        <p className="text-xs text-muted-foreground">
          Charged in {currency.toUpperCase()} — incl. {pct}% processing, itemised
          separately on your Stripe receipt.
        </p>
      )}
    </dl>
  );
}
