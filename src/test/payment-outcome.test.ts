import { describe, expect, it } from "vitest";
import {
  classifyOutcome,
  decideConfirmAction,
  outcomeMessage,
  type PaymentOutcome,
} from "@/lib/payment-outcome";

const decide = (
  outcome: PaymentOutcome,
  record: { paidSessionId: string | null; paymentState: string | null } | null,
  sessionId = "cs_new",
) =>
  decideConfirmAction({
    sessionId,
    outcome,
    reference: "HAR-AB12",
    referenceFound: true,
    record,
  });

describe("classifyOutcome", () => {
  it("treats paid and zero-cost sessions as paid", () => {
    expect(classifyOutcome({ status: "complete", paymentStatus: "paid" })).toBe("paid");
    expect(classifyOutcome({ status: "complete", paymentStatus: "no_payment_required" })).toBe("paid");
  });

  it("treats expired sessions as expired regardless of payment status", () => {
    expect(classifyOutcome({ status: "expired", paymentStatus: "unpaid" })).toBe("expired");
  });

  it("treats a completed-but-unpaid session as failed", () => {
    expect(classifyOutcome({ status: "complete", paymentStatus: "unpaid" })).toBe("failed");
  });

  it("treats an open session (declined card, buyer bounced) as pending", () => {
    expect(classifyOutcome({ status: "open", paymentStatus: "unpaid" })).toBe("pending");
    expect(classifyOutcome({ status: null, paymentStatus: null })).toBe("pending");
  });
});

describe("decideConfirmAction", () => {
  it("applies the first successful payment", () => {
    expect(decide("paid", { paidSessionId: null, paymentState: "unpaid" })).toEqual({
      action: "apply",
    });
  });

  it("is idempotent when the same session is replayed", () => {
    expect(decide("paid", { paidSessionId: "cs_new", paymentState: "paid" })).toEqual({
      action: "already_applied",
    });
  });

  it("flags a second paid session for the same submission instead of re-applying", () => {
    expect(decide("paid", { paidSessionId: "cs_first", paymentState: "paid" })).toEqual({
      action: "duplicate_session",
      paidSessionId: "cs_first",
    });
  });

  it("never downgrades a paid submission when a later attempt fails or expires", () => {
    for (const outcome of ["failed", "expired", "pending"] as PaymentOutcome[]) {
      expect(decide(outcome, { paidSessionId: "cs_first", paymentState: "paid" })).toEqual({
        action: "already_applied",
      });
      expect(decide(outcome, { paidSessionId: null, paymentState: "paid" })).toEqual({
        action: "already_applied",
      });
    }
  });

  it("records unpaid attempts without touching submission status", () => {
    for (const outcome of ["failed", "expired", "pending"] as PaymentOutcome[]) {
      expect(decide(outcome, { paidSessionId: null, paymentState: "unpaid" })).toEqual({
        action: "record_attempt",
        outcome,
      });
    }
  });

  it("allows a retry session to settle an order that previously failed", () => {
    expect(decide("paid", { paidSessionId: null, paymentState: "failed" }, "cs_retry")).toEqual({
      action: "apply",
    });
  });

  it("skips when there is no reference or the reference is unknown", () => {
    expect(
      decideConfirmAction({
        sessionId: "cs_x",
        outcome: "paid",
        reference: null,
        referenceFound: null,
        record: null,
      }),
    ).toEqual({ action: "skip" });
    expect(
      decideConfirmAction({
        sessionId: "cs_x",
        outcome: "paid",
        reference: "HAR-ZZ99",
        referenceFound: false,
        record: { paidSessionId: null, paymentState: "unpaid" },
      }),
    ).toEqual({ action: "skip" });
  });

  it("reaches the same verdict when the return page is loaded many times", () => {
    const record = { paidSessionId: "cs_new", paymentState: "paid" };
    const verdicts = Array.from({ length: 5 }, () => decide("paid", record));
    expect(new Set(verdicts.map((v) => v.action))).toEqual(new Set(["already_applied"]));
  });
});

describe("outcomeMessage", () => {
  it("gives every non-paid outcome an actionable, no-charge message", () => {
    for (const outcome of ["failed", "expired", "pending"] as PaymentOutcome[]) {
      const message = outcomeMessage(outcome);
      expect(message.length).toBeGreaterThan(20);
      expect(message.toLowerCase()).toMatch(/retry|refresh|again/);
    }
  });
});
