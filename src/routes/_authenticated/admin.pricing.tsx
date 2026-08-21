import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Percent, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PricingAccessCheckCard } from "@/components/PricingAccessCheckCard";
import { PricingAccessAlertsCard } from "@/components/PricingAccessAlertsCard";

import {
  getSurchargeAudit,
  getSurchargeSettings,
  updateSurchargeSettings,
} from "@/lib/pricing-settings.functions";
import {
  CURRENCIES,
  CURRENCY_CODES,
  DEFAULT_SURCHARGE_BPS,
  MAX_SURCHARGE_BPS,
  PACKAGE_PRICES,
  applySurchargeBps,
  formatAmount,
  type CurrencyCode,
} from "@/lib/pricing";

export const Route = createFileRoute("/_authenticated/admin/pricing")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/pricing",
      title: "Processing Surcharge Settings — Hybrid AI Records",
      description: "Private admin control for the cross-border processing surcharge applied to non-USD checkouts.",
      socialTitle: "Processing Surcharge Settings — Hybrid AI Records",
      socialDescription: "Admin control for the non-USD processing surcharge percentage.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminPricing,
});

/** Basis points -> a human percentage string, e.g. 250 -> "2.5". */
const toPercent = (bps: number) => String(Math.round(bps) / 100);
/** "2.5" -> 250 basis points, or null when the entry is unusable. */
const toBps = (value: string): number | null => {
  const n = Number(value.trim());
  if (!Number.isFinite(n)) return null;
  const bps = Math.round(n * 100);
  if (bps < 0 || bps > MAX_SURCHARGE_BPS) return null;
  return bps;
};

/** A representative package so admins can see the effect on a real price. */
const SAMPLE_PRICE_ID = "foundation_song_onetime";

function AdminPricing() {
  const load = useServerFn(getSurchargeSettings);
  const loadAudit = useServerFn(getSurchargeAudit);
  const save = useServerFn(updateSurchargeSettings);
  const [draft, setDraft] = useState<Record<CurrencyCode, string> | null>(null);

  const query = useQuery({ queryKey: ["surcharge-settings"], queryFn: () => load({}) });

  /** Admin-only: the last-editor identity. Fails closed for non-admin staff. */
  const auditQuery = useQuery({
    queryKey: ["surcharge-audit", query.data?.updatedAt ?? null],
    queryFn: () => loadAudit({}),
    retry: false,
  });
  const audit = auditQuery.isSuccess ? auditQuery.data : null;

  useEffect(() => {
    if (!query.data) return;
    applySurchargeBps(query.data.rates);
    setDraft(
      Object.fromEntries(
        CURRENCY_CODES.map((c) => [c, toPercent(query.data.rates[c])]),
      ) as Record<CurrencyCode, string>,
    );
  }, [query.data]);

  const mutation = useMutation({
    mutationFn: (rates: Record<CurrencyCode, number>) => save({ data: { rates } }),
    onSuccess: (res) => {
      applySurchargeBps(res.rates);
      setDraft(
        Object.fromEntries(CURRENCY_CODES.map((c) => [c, toPercent(res.rates[c])])) as Record<
          CurrencyCode,
          string
        >,
      );
      toast.success("Surcharge updated. New checkouts use these rates immediately.");
    },
    onError: (err: Error) =>
      toast.error(
        err.message === "Forbidden"
          ? "Only label admins can change the surcharge."
          : "Could not save the surcharge. Try again shortly.",
      ),
  });

  const invalid = draft
    ? CURRENCY_CODES.filter((c) => toBps(draft[c]) === null)
    : [];

  const onSave = () => {
    if (!draft || invalid.length > 0) return;
    const rates = Object.fromEntries(
      CURRENCY_CODES.map((c) => [c, toBps(draft[c])!]),
    ) as Record<CurrencyCode, number>;
    mutation.mutate(rates);
  };

  const resetDefaults = () =>
    setDraft(
      Object.fromEntries(
        CURRENCY_CODES.map((c) => [c, toPercent(DEFAULT_SURCHARGE_BPS[c])]),
      ) as Record<CurrencyCode, string>,
    );

  const sample = PACKAGE_PRICES[SAMPLE_PRICE_ID];

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-14 sm:px-8">
      <Link
        to="/admin/applications"
        className="inline-flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-primary"
      >
        <ArrowLeft size={14} aria-hidden="true" /> Applications inbox
      </Link>

      <header className="mt-8">
        <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
          <span className="text-[#e11d2e]">/</span> Admin
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold sm:text-4xl">
          Processing surcharge
        </h1>
        <p className="mt-3 max-w-xl text-sm text-muted-foreground">
          The cross-border processing fee added to non-USD checkouts. Changes apply to new
          checkout sessions, the price breakdowns on the site, and the itemized Stripe receipt —
          no code release needed. Maximum {MAX_SURCHARGE_BPS / 100}% per currency.
        </p>
      </header>

      {query.isPending && (
        <p className="mt-8 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading current rates…
        </p>
      )}

      {query.isError && (
        <p role="alert" className="mt-8 border border-[#e11d2e] bg-[#e11d2e]/10 p-4 text-sm">
          Could not load the current rates. Refresh and try again.
        </p>
      )}

      {draft && (
        <>
          <section className="mt-8 border border-border bg-white/[0.02] p-5">
            <h2 className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
              Rate per currency
            </h2>
            <ul className="mt-4 grid gap-4 sm:grid-cols-2">
              {CURRENCY_CODES.map((code) => {
                const bps = toBps(draft[code]);
                const bad = bps === null;
                const preview =
                  !bad && sample
                    ? formatAmount(
                        Math.ceil((sample.amounts[code] * (10_000 + bps)) / 10_000),
                        code,
                      )
                    : null;
                return (
                  <li key={code}>
                    <label
                      htmlFor={`bps-${code}`}
                      className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground"
                    >
                      {CURRENCIES[code].label} ({code.toUpperCase()})
                    </label>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        id={`bps-${code}`}
                        inputMode="decimal"
                        value={draft[code]}
                        onChange={(e) =>
                          setDraft((d) => (d ? { ...d, [code]: e.target.value } : d))
                        }
                        aria-invalid={bad || undefined}
                        aria-describedby={`bps-${code}-hint`}
                        className="w-28 border border-border bg-background/40 px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                      />
                      <Percent size={14} className="text-muted-foreground" aria-hidden="true" />
                    </div>
                    <p
                      id={`bps-${code}-hint`}
                      className={`mt-1 text-xs ${bad ? "text-[#ff9aa3]" : "text-muted-foreground"}`}
                    >
                      {bad
                        ? `Enter a percentage between 0 and ${MAX_SURCHARGE_BPS / 100}.`
                        : preview
                          ? `1-track Foundation charges ${preview}`
                          : ""}
                    </p>
                  </li>
                );
              })}
            </ul>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <Button
                onClick={onSave}
                disabled={mutation.isPending || invalid.length > 0}
                className="bg-[#e11d2e] text-white hover:opacity-90"
              >
                {mutation.isPending && (
                  <Loader2
                    size={14}
                    className="me-2 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
                Save rates
              </Button>
              <Button type="button" variant="outline" onClick={resetDefaults}>
                <RotateCcw size={14} className="me-2" aria-hidden="true" /> Restore defaults
              </Button>
              {query.data?.updatedAt && (
                <span className="text-xs text-muted-foreground">
                  Last changed {new Date(query.data.updatedAt).toLocaleString()}
                  {audit?.updatedById && (
                    <>
                      {" by "}
                      <span className="text-foreground">
                        {audit.updatedByEmail ?? `admin ${audit.updatedById.slice(0, 8)}`}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
          </section>

          <p className="mt-4 text-xs text-muted-foreground">
            USD settles natively and normally stays at 0%. Setting a currency to 0% removes its
            fee line item from checkout entirely.
          </p>

          <PricingAccessCheckCard />
          <PricingAccessAlertsCard />

        </>
      )}
    </main>
  );
}
