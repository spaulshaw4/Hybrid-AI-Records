import { describe, expect, it } from "vitest";
import {
  ENGINE_BUSY_REFUNDED_MESSAGE,
  isDbLockOrUnexpectedSpendError,
  isEngineBusyRefundedError,
  isStudioStreamDroppedError,
  isTransientUpstreamStatus,
  markEngineBusyRefunded,
  StudioStreamDroppedError,
  UPSTREAM_FAST_RETRY_ATTEMPTS,
} from "@/lib/engine-bounce-back";

describe("engine bounce-back contracts", () => {
  it("treats 5xx / 429 as transient upstream statuses", () => {
    expect(isTransientUpstreamStatus(429)).toBe(true);
    expect(isTransientUpstreamStatus(500)).toBe(true);
    expect(isTransientUpstreamStatus(503)).toBe(true);
    expect(isTransientUpstreamStatus(400)).toBe(false);
    expect(UPSTREAM_FAST_RETRY_ATTEMPTS).toBe(3);
  });

  it("marks refunded busy errors for the client toast", () => {
    const err = markEngineBusyRefunded(new Error("upstream 503"));
    expect(err.message).toBe(ENGINE_BUSY_REFUNDED_MESSAGE);
    expect(isEngineBusyRefundedError(err)).toBe(true);
    expect(isEngineBusyRefundedError(new Error(ENGINE_BUSY_REFUNDED_MESSAGE))).toBe(true);
  });

  it("flags stream drops as recoverable", () => {
    const err = new StudioStreamDroppedError();
    expect(isStudioStreamDroppedError(err)).toBe(true);
    expect(err.recoverable).toBe(true);
  });

  it("detects DB lock / contention codes for debit fallback", () => {
    expect(isDbLockOrUnexpectedSpendError({ code: "40001", message: "serialization" })).toBe(
      true,
    );
    expect(isDbLockOrUnexpectedSpendError({ message: "could not obtain lock" })).toBe(true);
    expect(isDbLockOrUnexpectedSpendError({ code: "23505", message: "unique" })).toBe(false);
  });
});
