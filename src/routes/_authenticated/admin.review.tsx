import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Inbox, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  listFlaggedPayments,
  resolveFlaggedPayment,
  REVIEW_CURRENCIES,
  type ReviewCurrency,
} from "@/lib/admin-review.functions";

export const Route = createFileRoute("/_authenticated/admin/review")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/admin/review",
      title: "Payment Review Queue — Hybrid AI Records",
      description: "Private staff queue for submissions flagged during checkout verification, filterable by currency.",
      socialTitle: "Payment Review Queue — Hybrid AI Records",
      socialDescription: "Staff-only queue for flagged payments awaiting a Stripe check.",
      image: null,
      card: "summary",
      noindex: true,
    }),
  component: AdminReview,
});

const FLAG_LABEL: Record<string, string> = {
  amount_mismatch: "Amount mismatch",
  duplicate_payment: "Duplicate payment",
};

function AdminReview() {
  const [currencies, setCurrencies] = useState<ReviewCurrency[]>([]);
  const [state, setState] = useState<"open" | "resolved" | "all">("open");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const fetchFlagged = useServerFn(listFlaggedPayments);
  const resolveFlag = useServerFn(resolveFlaggedPayment);
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["admin-review", currencies, state],
    queryFn: () => fetchFlagged({ data: { currencies, state, limit: 100 } }),
  });

  const mutation = useMutation({
    mutationFn: (vars: { reference: string; note: string; reopen: boolean }) =>
      resolveFlag({ data: vars }),
    onSuccess: (result) => {
      toast.success(result.resolved ? "Marked resolved" : "Re-opened for review");
      void queryClient.invalidateQueries({ queryKey: ["admin-review"] });
    },
    onError: (error: unknown) =>
      toast.error(error instanceof Error ? error.message : "Couldn't save that"),
  });

  const submissions = query.data?.submissions ?? [];
  const forbidden = query.isError && /forbidden/i.test((query.error as Error)?.message ?? "");

  const toggleCurrency = (code: ReviewCurrency) =>
    setCurrencies((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
    );

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <header className="mb-8">
        <p className="eyebrow">
          <span className="text-[#e11d2e]">/ Staff</span>{" "}
          <span className="text-white">— Payment review</span>
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight sm:text-4xl">
          Review Queue
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Submissions whose payment didn't match the published price, or that were paid
          twice. Check the Stripe session, then mark it resolved.
        </p>
        <Link
          to="/admin/applications"
          className="mt-4 inline-flex items-center gap-2 border border-border-strong px-4 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <Inbox size={13} aria-hidden="true" /> Applications inbox
        </Link>
      </header>

      {forbidden ? (
        <div
          role="alert"
          className="border border-destructive/40 bg-destructive/5 p-6 text-sm text-muted-foreground"
        >
          <p className="font-semibold text-foreground">This queue is staff-only.</p>
          <p className="mt-1">
            Your account doesn't have the admin or staff role yet. Ask the label owner to
            grant it, then reload this page.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
                Currency
              </span>
              {REVIEW_CURRENCIES.map((code) => (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleCurrency(code)}
                  aria-pressed={currencies.includes(code)}
                  className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors ${
                    currencies.includes(code)
                      ? "bg-[#e11d2e] text-black"
                      : "border border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {code}
                </button>
              ))}
              {currencies.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCurrencies([])}
                  className="font-mono text-[10px] uppercase tracking-[0.15em] text-muted-foreground underline hover:text-foreground"
                >
                  Clear
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {(["open", "resolved", "all"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setState(key)}
                  aria-pressed={state === key}
                  className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors ${
                    state === key
                      ? "bg-foreground text-background"
                      : "border border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {key}
                </button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void query.refetch()}
                disabled={query.isFetching}
              >
                {query.isFetching ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw size={14} aria-hidden="true" />
                )}
                Refresh
              </Button>
            </div>
          </div>

          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading flagged submissions…</p>
          ) : submissions.length === 0 ? (
            <p className="border border-border bg-background/40 p-6 text-sm text-muted-foreground">
              Nothing flagged{currencies.length ? ` in ${currencies.join(", ")}` : ""} right
              now. Clean payments go straight into review.
            </p>
          ) : (
            <ul className="space-y-4">
              {submissions.map((s) => (
                <li
                  key={s.reference}
                  className={`border p-5 ${
                    s.resolvedAt
                      ? "border-border bg-background/40"
                      : "border-[#e11d2e]/60 bg-[#e11d2e]/5"
                  }`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="flex items-center gap-2 font-mono text-sm font-bold text-[#4b8bff]">
                        {s.resolvedAt ? (
                          <CheckCircle2 size={14} className="text-emerald-400" aria-hidden="true" />
                        ) : (
                          <AlertTriangle size={14} className="text-[#e11d2e]" aria-hidden="true" />
                        )}
                        {s.reference}
                      </p>
                      <p className="mt-1 text-sm text-foreground">
                        {s.artist} · {s.packageLabel}
                      </p>
                      <p className="text-xs text-muted-foreground">{s.email}</p>
                    </div>
                    <div className="text-end">
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#e11d2e]">
                        {FLAG_LABEL[s.flag] ?? s.flag}
                      </p>
                      <p className="mt-1 font-mono text-sm text-foreground">
                        {s.amountLabel ?? "—"}
                      </p>
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        {s.currency ?? "unknown currency"}
                      </p>
                    </div>
                  </div>

                  {s.flagDetails && (
                    <p className="mt-3 text-sm text-foreground">{s.flagDetails}</p>
                  )}
                  {s.lastPaymentError && s.lastPaymentError !== s.flagDetails && (
                    <p className="mt-1 text-xs text-muted-foreground">{s.lastPaymentError}</p>
                  )}

                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="uppercase tracking-widest text-muted-foreground">
                        Paid session
                      </dt>
                      <dd className="break-all font-mono text-foreground">
                        {s.paidSessionId ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-widest text-muted-foreground">
                        Latest session
                      </dt>
                      <dd className="break-all font-mono text-foreground">
                        {s.lastSessionId ?? "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-widest text-muted-foreground">Paid at</dt>
                      <dd className="font-mono text-foreground">
                        {s.paidAt ? new Date(s.paidAt).toLocaleString() : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="uppercase tracking-widest text-muted-foreground">
                        Submission status
                      </dt>
                      <dd className="font-mono text-foreground">{s.status}</dd>
                    </div>
                  </dl>

                  {s.resolvedAt ? (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                      <p className="text-xs text-muted-foreground">
                        Resolved {new Date(s.resolvedAt).toLocaleString()}
                        {s.resolutionNote ? ` — ${s.resolutionNote}` : ""}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({ reference: s.reference, note: "", reopen: true })
                        }
                      >
                        <RotateCcw size={14} aria-hidden="true" /> Re-open
                      </Button>
                    </div>
                  ) : (
                    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row">
                      <label className="sr-only" htmlFor={`note-${s.reference}`}>
                        Resolution note for {s.reference}
                      </label>
                      <input
                        id={`note-${s.reference}`}
                        value={notes[s.reference] ?? ""}
                        onChange={(e) =>
                          setNotes((prev) => ({ ...prev, [s.reference]: e.target.value }))
                        }
                        placeholder="What did Stripe show? (optional note)"
                        className="flex-1 border border-border bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
                      />
                      <Button
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({
                            reference: s.reference,
                            note: notes[s.reference] ?? "",
                            reopen: false,
                          })
                        }
                      >
                        {mutation.isPending ? (
                          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <CheckCircle2 size={14} aria-hidden="true" />
                        )}
                        Mark resolved
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
