import { createFileRoute, Link } from "@tanstack/react-router";
import { pageHead } from "@/lib/social-meta";
import { useEffect, useState } from "react";
import { confirmCheckoutOrder, type AmountMismatch } from "@/lib/payments.functions";
import type { PaymentOutcome } from "@/lib/payment-outcome";
import { getStripeEnvironment } from "@/lib/stripe";
import { VideoDealTerms, VIDEO_TERMS_STORAGE_KEY } from "@/components/VideoDealTerms";
import { DeliveryDateRange } from "@/components/DeliveryDateRange";
import { readStoredPurchase, packageBySlug, type StoredPurchase } from "@/lib/purchase-delivery";
import { PostPaymentIntake } from "@/components/PostPaymentIntake";
import { VocalCallCard } from "@/components/VocalCallCard";
import { loadCallHandoff, type VocalCallHandoff } from "@/lib/vocal-call-link";
import { RouteErrorFallback } from "@/components/RouteErrorFallback";


export const Route = createFileRoute("/checkout/return")({
  errorComponent: RouteErrorFallback,
  head: () =>
    pageHead({
      path: "/checkout/return",
      title: "Order Complete — Hybrid AI Records LLC",
      description: "Thanks for booking with Hybrid AI Records. Your order is confirmed.",
      socialTitle: "Order Complete — Hybrid AI Records LLC",
      socialDescription: "Thanks for booking with Hybrid AI Records.",
      image: null,
      type: "website",
      card: "summary",
      noindex: true,
    }),
  validateSearch: (search: Record<string, unknown>): { session_id?: string } => ({
    session_id: typeof search.session_id === "string" ? search.session_id : undefined,
  }),
  component: CheckoutReturn,
});

type Confirmation = {
  paid: boolean;
  outcome: PaymentOutcome;
  outcomeMessage: string | null;
  alreadyConfirmed: boolean;
  duplicateOfSessionId: string | null;
  reference: string | null;
  amountLabel: string | null;
  email: string | null;
  mismatch: AmountMismatch | null;
};

function CheckoutReturn() {
  const { session_id: sessionId } = Route.useSearch();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [isVideoOrder, setIsVideoOrder] = useState(false);
  const [purchase, setPurchase] = useState<StoredPurchase | null>(null);
  const [call, setCall] = useState<VocalCallHandoff | null>(null);

  // The checkout flow tags the deal type so we can repeat the one-shoot terms here,
  // plus the package + purchase moment so we can date the delivery window.
  useEffect(() => {
    try {
      setIsVideoOrder(window.sessionStorage.getItem(VIDEO_TERMS_STORAGE_KEY) === "video");
    } catch {
      setIsVideoOrder(false);
    }
    setPurchase(readStoredPurchase());
    setCall(loadCallHandoff());
  }, []);




  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    confirmCheckoutOrder({ data: { sessionId, environment: getStripeEnvironment() } })
      .then((result) => {
        if (!active || !result.ok) return;
        setConfirmation({
          paid: result.paid,
          outcome: result.outcome,
          outcomeMessage: result.outcomeMessage,
          alreadyConfirmed: result.alreadyConfirmed,
          duplicateOfSessionId: result.duplicateOfSessionId,
          reference: result.reference,
          amountLabel: result.amountLabel,
          email: result.email,
          mismatch: result.mismatch,
        });
        // The buyer now stays on this page: it's where we collect the project
        // details that used to sit in front of checkout. The Order Status link
        // below is theirs to take whenever they're done.
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [sessionId]);
  return (
    <div className="min-h-dvh flex items-center justify-center p-8">
      <div className="max-w-2xl w-full border border-border bg-background/40 backdrop-blur-sm p-10 text-center">
        {sessionId ? (
          <>
            <h1 className="font-display text-4xl font-bold text-white">
              {confirmation && !confirmation.paid ? "Payment not completed." : "Order confirmed."}
            </h1>
            {confirmation && !confirmation.paid ? (
              <p className="mt-4 text-muted-foreground">{confirmation.outcomeMessage}</p>
            ) : (
              <p className="mt-4 text-muted-foreground">
                Thanks for booking with <span className="text-[#e11d2e]">Hybrid</span>{" "}
                <span className="text-white">AI</span>{" "}
                <span className="text-[#4b8bff]">Records</span>. We'll be in touch shortly to kick things off.
              </p>
            )}

            {confirmation?.paid && confirmation.alreadyConfirmed && !confirmation.duplicateOfSessionId && (
              <p className="mt-3 text-xs uppercase tracking-widest text-[#4b8bff]">
                Already confirmed — we didn't charge or update anything twice.
              </p>
            )}

            {confirmation && !confirmation.paid && (
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="border border-border px-5 py-2 text-xs uppercase tracking-widest text-white hover:bg-background/60"
                >
                  Check again
                </button>
                <Link
                  to="/start"
                  className="bg-[#e11d2e] px-5 py-2 text-xs uppercase tracking-widest text-white hover:opacity-90"
                >
                  Retry checkout
                </Link>
              </div>
            )}

            {confirmation?.duplicateOfSessionId && (
              <div role="alert" className="mt-6 border border-[#e11d2e] bg-[#e11d2e]/10 p-4 text-start">
                <p className="text-xs font-semibold uppercase tracking-widest text-[#e11d2e]">
                  Possible duplicate payment
                </p>
                <p className="mt-2 text-sm text-white">
                  This submission was already paid by an earlier checkout, so we left its status
                  untouched. We've flagged the extra payment for a refund review — nothing about
                  your order changed.
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Email{" "}
                  <a href="mailto:info@hybrid-ai-records.com" className="underline hover:text-white">
                    info@hybrid-ai-records.com
                  </a>{" "}
                  with your reference to fast-track the refund.
                </p>
              </div>
            )}
            {confirmation?.mismatch && (
              <div
                role="alert"
                className="mt-6 border border-[#e11d2e] bg-[#e11d2e]/10 p-4 text-start"
              >
                <p className="text-xs font-semibold uppercase tracking-widest text-[#e11d2e]">
                  Payment amount needs review
                </p>
                <ul className="mt-2 list-disc space-y-1 ps-5 text-sm text-white">
                  {confirmation.mismatch.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>

                <table className="mt-4 w-full border border-[#e11d2e]/40 text-sm">
                  <caption className="sr-only">Expected versus charged payment details</caption>
                  <thead>
                    <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
                      <th scope="col" className="px-3 py-2 text-start font-semibold"> </th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">Expected</th>
                      <th scope="col" className="px-3 py-2 text-end font-semibold">Charged</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#e11d2e]/25">
                    <tr>
                      <th scope="row" className="px-3 py-2 text-start text-xs font-normal text-muted-foreground">
                        Total
                      </th>
                      <td className="px-3 py-2 text-end font-mono text-white">
                        {confirmation.mismatch.expectedLabel ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-end font-mono font-bold text-[#e11d2e]">
                        {confirmation.mismatch.chargedLabel ?? "—"}
                      </td>
                    </tr>
                    <tr>
                      <th scope="row" className="px-3 py-2 text-start text-xs font-normal text-muted-foreground">
                        Currency
                      </th>
                      <td className="px-3 py-2 text-end font-mono text-white">
                        {confirmation.mismatch.expectedCurrency ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-end font-mono ${
                          confirmation.mismatch.chargedCurrency !== confirmation.mismatch.expectedCurrency
                            ? "font-bold text-[#e11d2e]"
                            : "text-white"
                        }`}
                      >
                        {confirmation.mismatch.chargedCurrency ?? "—"}
                      </td>
                    </tr>
                    {confirmation.mismatch.differenceLabel && (
                      <tr>
                        <th scope="row" className="px-3 py-2 text-start text-xs font-normal text-muted-foreground">
                          Difference
                        </th>
                        <td className="px-3 py-2" />
                        <td className="px-3 py-2 text-end font-mono font-bold text-[#e11d2e]">
                          {confirmation.mismatch.differenceLabel}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                <dl className="mt-4 space-y-2 text-xs">
                  <div>
                    <dt className="uppercase tracking-widest text-muted-foreground">Submission reference</dt>
                    <dd className="font-mono break-all text-white">
                      {confirmation.mismatch.reference ?? confirmation.reference ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-widest text-muted-foreground">Stripe session ID</dt>
                    <dd className="font-mono break-all text-white">
                      {confirmation.mismatch.sessionId ?? sessionId ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="uppercase tracking-widest text-muted-foreground">Stripe payment ID</dt>
                    <dd className="font-mono break-all text-white">
                      {confirmation.mismatch.paymentIntentId ?? "—"}
                    </dd>
                  </div>
                </dl>

                <p className="mt-3 text-xs text-muted-foreground">
                  Your payment is safe — we've flagged this order for a human to check before
                  production starts. Email{" "}
                  <a href="mailto:info@hybrid-ai-records.com" className="underline hover:text-white">
                    info@hybrid-ai-records.com
                  </a>{" "}
                  with the reference and session ID above if you need it sorted fast.
                </p>
              </div>
            )}

            {confirmation?.reference && (
              <div className="mt-6 border border-border bg-background/50 p-4 text-start">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">Your track reference</p>
                <p className="mt-1 font-mono text-lg font-bold text-[#4b8bff]">{confirmation.reference}</p>
                {confirmation.amountLabel && confirmation.paid && (
                  <p className="mt-1 text-sm text-muted-foreground">Paid {confirmation.amountLabel}</p>
                )}
                {!confirmation.mismatch && confirmation.paid && !confirmation.duplicateOfSessionId && (
                  <p className="mt-2 text-xs text-[#4b8bff]">
                    Add your project details below, then open your Order Status page any time.
                  </p>
                )}
                <a
                  href={`/order-status?ref=${encodeURIComponent(confirmation.reference)}${
                    confirmation.email ? `&email=${encodeURIComponent(confirmation.email)}` : ""
                  }`}
                  className="mt-3 inline-block text-xs uppercase tracking-widest text-white underline hover:text-[#e11d2e]"
                >
                  Track your submission
                </a>
              </div>
            )}
            {purchase && confirmation?.paid && (
              <DeliveryDateRange
                className="mt-6"
                slug={purchase.slug}
                purchasedAt={new Date(purchase.purchasedAt)}
                purchaseLabel={`purchase date${
                  packageBySlug(purchase.slug) ? ` — ${packageBySlug(purchase.slug)!.title}` : ""
                }`}
              />
            )}
            {call && confirmation?.paid && (
              <VocalCallCard
                className="mt-6"
                meetingLink={call.meetingLink}
                date={call.date}
                altDate={call.altDate}
                window={call.window}
                timezone={call.timezone}
              />
            )}
            {isVideoOrder && (
              <VideoDealTerms className="mt-6" title="Your video deal terms" />
            )}
            {confirmation?.paid && !confirmation.mismatch && (
              <PostPaymentIntake
                className="mt-6"
                pkg={purchase ? packageBySlug(purchase.slug) : null}
                reference={confirmation.reference}
              />
            )}
            <p className="mt-4 text-xs font-mono text-muted-foreground/70 break-all">Session: {sessionId}</p>

          </>
        ) : (
          <>
            <h1 className="font-display text-3xl font-bold text-white">No session found.</h1>
            <p className="mt-4 text-muted-foreground">If you were mid-checkout, please try again.</p>
          </>
        )}
        <Link to="/" className="mt-8 inline-block border border-border px-6 py-3 text-sm uppercase tracking-widest text-white hover:bg-background/60">
          Back to Home
        </Link>
      </div>
    </div>
  );
}
