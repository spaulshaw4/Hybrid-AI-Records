import { RouteErrorFallback } from "@/components/RouteErrorFallback";
import { PortalBreadcrumb } from "@/components/PortalBreadcrumb";
import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  CalendarClock,
  CheckCircle2,
  Loader2,
  PackageCheck,
  RefreshCw,
  Search,
  Truck,
} from "lucide-react";
import {
  TRACK_STATUS_STEPS,
  lookupTrackRequest,
  updateRevisionRequest,
  type TrackStatusKey,
} from "@/lib/track-requests.functions";
import { checkNotes } from "@/lib/form-guard";
import {
  INCLUDED_REVISION_ROUNDS,
  deliveryEstimate,
  formatDeliveryDate,
} from "@/lib/delivery-estimate";

export const Route = createFileRoute("/order-status")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/order-status",
      title: "Order Status — Hybrid AI Records",
      description: "Look up your Hybrid AI Records order to see your confirmation details, expected delivery dates, and to file or update a revision request.",
      socialTitle: "Order Status — Hybrid AI Records",
      socialDescription: "Confirmation details, expected delivery window, and revision requests for your Hybrid AI Records order.",
      type: "website",
      card: "summary_large_image",
      noindex: true,
    }),
  validateSearch: (search: Record<string, unknown>): { ref?: string; email?: string } => ({
    ...(typeof search.ref === "string" ? { ref: search.ref } : {}),
    ...(typeof search.email === "string" ? { email: search.email } : {}),
  }),
  component: OrderStatusPage,
});

type Order = {
  reference: string;
  artist: string;
  email: string;
  packageLabel: string;
  link: string | null;
  notes: string | null;
  status: TrackStatusKey;
  statusNote: string | null;
  paidAt: string | null;
  paidAmountLabel: string | null;
  paymentCurrency: string | null;
  reviewStartedAt: string | null;
  revisionRequest: string | null;
  revisionUpdatedAt: string | null;
  revisionRound: number;
  lockedTier?: string | null;
  lockedTurnaroundLabel?: string | null;
  lockedDeliveryEarliest?: string | null;
  lockedDeliveryLatest?: string | null;
  tierLockedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const statusLabel = (key: TrackStatusKey) =>
  TRACK_STATUS_STEPS.find((s) => s.key === key)?.label ?? key;

function OrderStatusPage() {
  const search = Route.useSearch();
  const lookup = useServerFn(lookupTrackRequest);
  const saveRevision = useServerFn(updateRevisionRequest);

  const [reference, setReference] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const resultRef = useRef<HTMLDivElement | null>(null);

  const [revision, setRevision] = useState("");
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [revisionStatus, setRevisionStatus] = useState<string | null>(null);
  const [savingRevision, setSavingRevision] = useState<"save" | "round" | null>(null);

  const load = async (ref: string, mail: string) => {
    setLoading(true);
    setError(null);
    setAnnouncement("Loading your order…");
    try {
      const res = await lookup({ data: { reference: ref.trim(), email: mail.trim() } });
      if (!res.found) {
        setOrder(null);
        setError("No order matches that reference code and email. Check both and try again.");
        setAnnouncement("No matching order found.");
        return;
      }
      setOrder(res.request as Order);
      setRevision(res.request.revisionRequest ?? "");
      setRevisionStatus(null);
      setAnnouncement(`Order ${res.request.reference} loaded.`);
      requestAnimationFrame(() => resultRef.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again shortly.");
      setAnnouncement("Order lookup failed.");
    } finally {
      setLoading(false);
    }
  };

  // Confirmation redirects and receipt emails link straight here with both keys.
  useEffect(() => {
    if (search.ref) setReference(search.ref.toUpperCase());
    if (search.email) setEmail(search.email);
    if (search.ref && search.email) void load(search.ref, search.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.ref, search.email]);

  const submitLookup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reference.trim() || !email.trim()) {
      setError("Enter both your reference code and the email you applied with.");
      return;
    }
    void load(reference, email);
  };

  const submitRevision = async (mode: "save" | "round") => {
    if (!order) return;
    const problem = revision.trim().length > 0 ? checkNotes(revision) : null;
    if (problem) {
      setRevisionError(problem);
      return;
    }
    setRevisionError(null);
    setSavingRevision(mode);
    try {
      const res = await saveRevision({
        data: {
          reference: order.reference,
          email: order.email,
          request: revision.trim(),
          newRound: mode === "round",
        },
      });
      if (!res.ok) {
        setRevisionError("We could not verify this order. Reload the page and look it up again.");
        return;
      }
      setOrder({
        ...order,
        revisionRequest: res.request,
        revisionRound: res.round,
        revisionUpdatedAt: res.updatedAt,
      });
      setRevisionStatus(
        mode === "round"
          ? `Revision round ${res.round} submitted — the team is notified on their next queue check.`
          : res.request
            ? "Revision request saved."
            : "Revision request cleared.",
      );
    } catch (e) {
      setRevisionError(e instanceof Error ? e.message : "Could not save. Try again shortly.");
    } finally {
      setSavingRevision(null);
    }
  };

  const baseEstimate = order
    ? deliveryEstimate({
        packageLabel: order.lockedTier || order.packageLabel,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        status: order.status,
      })
    : null;

  // Once payment clears we stamp the tier + window on the order. Those stored
  // dates win, so the promise the artist paid for can never shift later.
  const estimate =
    baseEstimate && order?.lockedDeliveryEarliest && order.lockedDeliveryLatest
      ? {
          ...baseEstimate,
          window: {
            ...baseEstimate.window,
            label: order.lockedTurnaroundLabel || baseEstimate.window.label,
          },
          earliest: new Date(order.lockedDeliveryEarliest),
          latest: new Date(order.lockedDeliveryLatest),
        }
      : baseEstimate;

  const roundsLeft = order ? Math.max(0, INCLUDED_REVISION_ROUNDS - order.revisionRound) : 0;

  return (
    <main className="relative min-h-dvh bg-background/40 px-4 py-12 backdrop-blur-sm sm:px-8">
      <div className="mx-auto w-full max-w-3xl">
        <PortalBreadcrumb trail={[{ label: "Order Status" }]} />

        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.24em] text-[#e11d2e]">
          / Order Status
        </p>
        <h1 className="mt-3 font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Your order, start to delivery.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Enter the reference code from your confirmation email plus the address you applied with.
          You&rsquo;ll see your confirmation details, the expected delivery window, and you can file
          or update a revision request at any time.
        </p>

        <form
          onSubmit={submitLookup}
          className="mt-8 grid gap-4 border border-border bg-background/40 p-5 backdrop-blur-sm sm:grid-cols-[1fr_1fr_auto]"
        >
          <div>
            <label htmlFor="order-ref" className="text-xs font-medium text-white">
              Reference code
            </label>
            <input
              id="order-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value.toUpperCase())}
              placeholder="HAR-XXXXXX"
              autoComplete="off"
              className="mt-1 w-full border border-border bg-background/60 px-3 py-2 font-mono text-sm text-white outline-none placeholder:text-white/30 focus:border-primary"
            />
          </div>
          <div>
            <label htmlFor="order-email" className="text-xs font-medium text-white">
              Contact email
            </label>
            <input
              id="order-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-primary"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="mt-1 inline-flex items-center justify-center gap-2 self-end border border-[#e11d2e] bg-[#e11d2e] px-5 py-2.5 text-xs font-semibold uppercase tracking-widest text-black transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            {loading ? "Looking up" : "Find order"}
          </button>
        </form>

        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>

        {error && (
          <p
            role="alert"
            className="mt-4 border border-[#e11d2e]/60 bg-[#e11d2e]/10 px-4 py-3 text-sm text-white"
          >
            {error}
          </p>
        )}

        {order && estimate && (
          <div ref={resultRef} tabIndex={-1} className="mt-10 space-y-6 outline-none">
            {/* CONFIRMATION DETAILS */}
            <section className="border border-border bg-background/40 p-6 backdrop-blur-sm">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-white">
                <PackageCheck size={18} className="text-[#e11d2e]" aria-hidden />
                Confirmation details
              </h2>
              <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                    Reference
                  </dt>
                  <dd className="mt-1 font-mono text-white">{order.reference}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                    Package
                  </dt>
                  <dd className="mt-1 text-white">{order.packageLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">Artist</dt>
                  <dd className="mt-1 text-white">{order.artist}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">Email</dt>
                  <dd className="mt-1 break-all text-white">{order.email}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                    Payment
                  </dt>
                  <dd className="mt-1 text-white">
                    {order.paidAt
                      ? `${order.paidAmountLabel ?? "Paid"}${
                          order.paymentCurrency ? ` (${order.paymentCurrency.toUpperCase()})` : ""
                        } — ${fmt(order.paidAt)}`
                      : "Not paid yet — awaiting your plan and invoice."}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-muted-foreground">Placed</dt>
                  <dd className="mt-1 text-white">{fmt(order.createdAt)}</dd>
                </div>
              </dl>

              <p className="mt-5 inline-flex items-center gap-2 border border-border bg-background/60 px-3 py-2 text-xs text-white">
                <CheckCircle2 size={14} className="text-[#e11d2e]" aria-hidden />
                Current stage: <strong className="font-semibold">{statusLabel(order.status)}</strong>
              </p>
              {order.statusNote && (
                <p className="mt-3 border-l-2 border-[#e11d2e] pl-3 text-sm leading-relaxed text-white/80">
                  {order.statusNote}
                </p>
              )}
            </section>


            {/* EXPECTED DELIVERY */}
            <section className="border border-border bg-background/40 p-6 backdrop-blur-sm">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-white">
                <Truck size={18} className="text-[#e11d2e]" aria-hidden />
                Expected delivery
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {estimate.window.label} from {estimate.startLabel} ({fmt(estimate.startedAt.toISOString())}).
                Weekends don&rsquo;t count toward the window.
              </p>
              {order.tierLockedAt && (
                <p className="mt-2 inline-flex items-center gap-2 border border-[#4b8bff]/50 bg-[#4b8bff]/10 px-3 py-1.5 text-xs text-white">
                  Locked in on payment: {order.lockedTier || order.packageLabel} ·{" "}
                  {order.lockedTurnaroundLabel || estimate.window.label}
                </p>
              )}

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div className="border border-border bg-background/60 p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    Earliest delivery
                  </p>
                  <p className="mt-1 font-display text-lg font-semibold text-white">
                    {formatDeliveryDate(estimate.earliest)}
                  </p>
                </div>
                <div className="border border-border bg-background/60 p-4">
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">
                    Latest delivery
                  </p>
                  <p className="mt-1 font-display text-lg font-semibold text-white">
                    {formatDeliveryDate(estimate.latest)}
                  </p>
                </div>
              </div>

              <p className="mt-4 flex items-start gap-2 text-sm text-white/80">
                <CalendarClock size={16} className="mt-0.5 shrink-0 text-[#4b8bff]" aria-hidden />
                {estimate.delivered
                  ? "Delivered — your files and links are in your inbox."
                  : estimate.overdue
                    ? "We're past the quoted window. Message the team on WhatsApp and we'll give you a same-day update."
                    : `About ${estimate.businessDaysRemaining} business day${
                        estimate.businessDaysRemaining === 1 ? "" : "s"
                      } left in the window.`}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                What you receive: {estimate.window.deliverable}
              </p>
            </section>

            {/* REVISION REQUESTS */}
            <section className="border border-border bg-background/40 p-6 backdrop-blur-sm">
              <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-white">
                <RefreshCw size={18} className="text-[#e11d2e]" aria-hidden />
                Revision requests
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {INCLUDED_REVISION_ROUNDS} rounds of mix revisions are included. You&rsquo;ve used{" "}
                <strong className="text-white">{order.revisionRound}</strong> — {roundsLeft} included{" "}
                {roundsLeft === 1 ? "round" : "rounds"} left. Extra rounds are quoted per request.
                Send all notes for a round together.
              </p>

              <label htmlFor="revision-text" className="mt-4 block text-xs font-medium text-white">
                Your revision notes
              </label>
              <textarea
                id="revision-text"
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
                rows={6}
                maxLength={4000}
                placeholder="e.g. Bring the lead vocal up 1 dB in the chorus, tighten the 2nd verse ad-libs, and shorten the intro by 4 bars."
                aria-describedby="revision-help"
                className="mt-1 w-full border border-border bg-background/60 px-3 py-2 text-sm leading-relaxed text-white outline-none placeholder:text-white/30 focus:border-primary"
              />
              <p id="revision-help" className="mt-1 text-xs text-muted-foreground">
                {order.revisionUpdatedAt
                  ? `Last updated ${fmt(order.revisionUpdatedAt)}.`
                  : "Nothing filed yet."}{" "}
                {revision.length}/4000 characters.
              </p>

              {revisionError && (
                <p role="alert" className="mt-3 text-sm text-[#e11d2e]">
                  {revisionError}
                </p>
              )}
              {revisionStatus && (
                <p aria-live="polite" className="mt-3 text-sm text-[#4b8bff]">
                  {revisionStatus}
                </p>
              )}

              <div className="mt-4 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void submitRevision("save")}
                  disabled={savingRevision !== null}
                  className="inline-flex items-center gap-2 border border-white px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-white transition-colors hover:bg-white hover:text-black disabled:opacity-60"
                >
                  {savingRevision === "save" && <Loader2 size={14} className="animate-spin" />}
                  Save changes
                </button>
                <button
                  type="button"
                  onClick={() => void submitRevision("round")}
                  disabled={savingRevision !== null || revision.trim().length === 0}
                  className="inline-flex items-center gap-2 border border-[#e11d2e] bg-[#e11d2e] px-4 py-2.5 text-xs font-semibold uppercase tracking-widest text-black transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {savingRevision === "round" && <Loader2 size={14} className="animate-spin" />}
                  Submit as new round
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
