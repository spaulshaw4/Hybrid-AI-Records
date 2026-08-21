/**
 * Pure helpers for reading what actually happened to a Stripe Checkout Session.
 *
 * Stripe sessions are not a simple paid/unpaid flag: a buyer can abandon a
 * session, have a card declined and retry inside the same session, let it
 * expire, or start a whole new session for the same submission. The return
 * page can also be reloaded, shared, or replayed. These helpers turn all of
 * that into one small, testable verdict so the confirmation path never
 * double-applies a payment or wipes a real payment with a failed retry.
 */

/** What a single checkout attempt ended up doing. */
export type PaymentOutcome = "paid" | "pending" | "expired" | "failed";

export type SessionSnapshot = {
  /** Stripe session.status: "open" | "complete" | "expired" | null. */
  status: string | null;
  /** Stripe session.payment_status. */
  paymentStatus: string | null;
};

/** Reduce a Stripe session to one of four plain outcomes. */
export function classifyOutcome({ status, paymentStatus }: SessionSnapshot): PaymentOutcome {
  if (paymentStatus === "paid" || paymentStatus === "no_payment_required") return "paid";
  if (status === "expired") return "expired";
  if (status === "complete") return "failed"; // completed without money changing hands
  return "pending"; // still open — buyer bounced back before finishing or after a decline
}

/** The submission row fields the confirmation path cares about. */
export type PaymentRecord = {
  paidSessionId: string | null;
  paymentState: string | null;
};

export type ConfirmDecision =
  /** Apply the paid update; this is the first time this session succeeded. */
  | { action: "apply" }
  /** This exact session was already applied — report success, change nothing. */
  | { action: "already_applied" }
  /** A different session already paid this submission — flag, change nothing. */
  | { action: "duplicate_session"; paidSessionId: string }
  /** Not paid: record the attempt only, never touch the submission's status. */
  | { action: "record_attempt"; outcome: PaymentOutcome }
  /** Nothing to do (no reference, or the reference isn't a real submission). */
  | { action: "skip" };

/**
 * Decide what the confirmation path should do for one return-page visit.
 * Deliberately side-effect free so retries, reloads, and duplicate tabs all
 * resolve to the same answer.
 */
export function decideConfirmAction(input: {
  sessionId: string;
  outcome: PaymentOutcome;
  reference: string | null;
  referenceFound: boolean | null;
  record: PaymentRecord | null;
}): ConfirmDecision {
  const { sessionId, outcome, reference, referenceFound, record } = input;
  if (!reference || referenceFound !== true || !record) return { action: "skip" };

  // Same session replayed (reload, back button, shared link): never re-apply.
  if (record.paidSessionId === sessionId) return { action: "already_applied" };

  if (outcome !== "paid") {
    // A failed or abandoned retry must not downgrade an order that already paid.
    if (record.paymentState === "paid") return { action: "already_applied" };
    return { action: "record_attempt", outcome };
  }

  // Paid, but a different session already settled this submission.
  if (record.paidSessionId) {
    return { action: "duplicate_session", paidSessionId: record.paidSessionId };
  }
  if (record.paymentState === "paid") return { action: "already_applied" };

  return { action: "apply" };
}

/** Buyer-facing sentence for a non-paid return. */
export function outcomeMessage(outcome: PaymentOutcome): string {
  switch (outcome) {
    case "expired":
      return "This checkout session expired before payment completed. Nothing was charged — start the checkout again and your reference stays the same.";
    case "failed":
      return "The payment didn't go through. Nothing was charged — you can retry checkout with the same reference.";
    case "pending":
      return "We haven't seen a completed payment for this checkout yet. If your bank is still confirming, refresh in a moment; otherwise you can safely retry.";
    case "paid":
      return "Payment received.";
  }
}
