/**
 * Server-only persistence for checkout confirmations.
 *
 * Every write here is idempotent: applying a paid session is guarded by the
 * `paid_session_id` column (unique when set), so concurrent return-page loads
 * or a replayed webhook can only ever produce one paid transition.
 */
import {
  decideConfirmAction,
  type ConfirmDecision,
  type PaymentOutcome,
} from "@/lib/payment-outcome";
import { deliveryEstimate } from "@/lib/delivery-estimate";

export type ApplyResult = {
  decision: ConfirmDecision["action"];
  /** True when this submission is settled — now or by an earlier attempt. */
  settled: boolean;
  /** Set when a different Stripe session already paid this submission. */
  duplicateOfSessionId: string | null;
  /** Amount label already stored, when we didn't write a new one. */
  storedAmountLabel: string | null;
};

export async function applyCheckoutOutcome(input: {
  sessionId: string;
  reference: string | null;
  referenceFound: boolean | null;
  outcome: PaymentOutcome;
  amountLabel: string | null;
  issues: string[];
  /** Currency Stripe charged, so staff can filter the review queue by it. */
  currency?: string | null;
}): Promise<ApplyResult> {
  const { sessionId, reference, referenceFound, outcome, amountLabel, issues } = input;
  const currency = input.currency ? input.currency.toUpperCase() : null;
  const idle: ApplyResult = {
    decision: "skip",
    settled: false,
    duplicateOfSessionId: null,
    storedAmountLabel: null,
  };
  if (!reference || referenceFound !== true) return idle;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: row, error: readError } = await supabaseAdmin
    .from("track_requests")
    .select("paid_session_id, payment_state, paid_amount_label, package_label")
    .eq("reference_code", reference)
    .maybeSingle();
  if (readError || !row) {
    if (readError) console.error("Payment state read failed:", readError.message);
    return idle;
  }

  const decision = decideConfirmAction({
    sessionId,
    outcome,
    reference,
    referenceFound,
    record: { paidSessionId: row.paid_session_id, paymentState: row.payment_state },
  });
  const now = new Date().toISOString();

  if (decision.action === "already_applied") {
    return {
      decision: decision.action,
      settled: true,
      duplicateOfSessionId: null,
      storedAmountLabel: row.paid_amount_label,
    };
  }

  if (decision.action === "duplicate_session") {
    // Two successful sessions for one submission: never charge status twice,
    // just leave a trail so staff can refund the extra one.
    const { error } = await supabaseAdmin
      .from("track_requests")
      .update({
        last_payment_session_id: sessionId,
        last_payment_attempt_at: now,
        last_payment_error: `Duplicate paid session ${sessionId}; already settled by ${decision.paidSessionId}. Needs refund review.`,
        ...(currency ? { payment_currency: currency } : {}),
        review_flag: "duplicate_payment",
        flag_details: `Second paid session ${sessionId}; original ${decision.paidSessionId}.`,
        flagged_at: now,
        flag_resolved_at: null,
        flag_resolved_by: null,
      })
      .eq("reference_code", reference);
    if (error) console.error("Duplicate payment note failed:", error.message);
    return {
      decision: decision.action,
      settled: true,
      duplicateOfSessionId: decision.paidSessionId,
      storedAmountLabel: row.paid_amount_label,
    };
  }

  if (decision.action === "record_attempt") {
    // Failed / expired / still-open: log the attempt, leave status untouched.
    const { error } = await supabaseAdmin
      .from("track_requests")
      .update({
        payment_state: decision.outcome === "pending" ? "unpaid" : "failed",
        last_payment_session_id: sessionId,
        last_payment_attempt_at: now,
        last_payment_error: `Checkout ${decision.outcome} (${sessionId}).`,
      })
      .eq("reference_code", reference)
      .is("paid_session_id", null);
    if (error) console.error("Failed payment note failed:", error.message);
    return {
      decision: decision.action,
      settled: false,
      duplicateOfSessionId: null,
      storedAmountLabel: row.paid_amount_label,
    };
  }

  if (decision.action !== "apply") return idle;

  // Lock the tier and the turnaround promise at the moment money clears, so a
  // later price/turnaround change can never move this artist's due date.
  const lock = deliveryEstimate({
    packageLabel: row.package_label ?? "",
    createdAt: now,
    paidAt: now,
    status: "in_review",
  });

  const note = issues.length
    ? `Paid${amountLabel ? ` ${amountLabel}` : ""} — AMOUNT MISMATCH, needs review: ${issues.join(" ")}`
    : `Paid${amountLabel ? ` ${amountLabel}` : ""} — ${row.package_label ?? "package"} locked in, delivery ${lock.window.label}.`;

  // The `.is("paid_session_id", null)` guard makes this a compare-and-set:
  // whichever concurrent call lands first wins, the rest update zero rows.
  const { data: updated, error } = await supabaseAdmin
    .from("track_requests")
    .update({
      status: issues.length ? "received" : "in_review",
      status_note: note,
      paid_at: now,
      paid_amount_label: amountLabel,
      // Clean orders go straight into review; flagged ones wait for a human.
      review_started_at: issues.length ? null : now,
      paid_session_id: sessionId,
      payment_state: "paid",
      last_payment_session_id: sessionId,
      last_payment_attempt_at: now,
      last_payment_error: null,
      payment_currency: currency,
      review_flag: issues.length ? "amount_mismatch" : null,
      flag_details: issues.length ? issues.join(" ") : null,
      flagged_at: issues.length ? now : null,
      flag_resolved_at: null,
      flag_resolved_by: null,
      flag_resolution_note: null,
      locked_tier: row.package_label ?? null,
      locked_turnaround_label: lock.window.label,
      locked_delivery_earliest: lock.earliest.toISOString(),
      locked_delivery_latest: lock.latest.toISOString(),
      tier_locked_at: now,
    })
    .eq("reference_code", reference)
    .is("paid_session_id", null)
    .select("reference_code");
  if (error) console.error("Order confirm update failed:", error.message);

  const applied = Boolean(updated?.length);
  return {
    decision: applied ? "apply" : "already_applied",
    settled: true,
    duplicateOfSessionId: null,
    storedAmountLabel: applied ? amountLabel : row.paid_amount_label,
  };
}
