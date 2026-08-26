/**
 * Shared bounce-back contracts for Hybrid Engine resilience.
 * Keep copy stable — client toasts and server SSE errors match on these strings.
 */

export const ENGINE_BUSY_REFUNDED_MESSAGE = "Engine busy, token refunded";

/** Fast retries against a single upstream host before host failover / refund. */
export const UPSTREAM_FAST_RETRY_ATTEMPTS = 3;
export const UPSTREAM_FAST_RETRY_DELAYS_MS = [250, 750, 1500] as const;

export function isTransientUpstreamStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function isTransientUpstreamError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isFinite(status) && isTransientUpstreamStatus(status)) return true;
  }
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("network") ||
    text.includes("fetch failed") ||
    text.includes("econnreset") ||
    text.includes("socket hang up") ||
    text.includes("503") ||
    text.includes("502") ||
    text.includes("504") ||
    text.includes("429")
  );
}

export function markEngineBusyRefunded(cause: unknown): Error & {
  refunded: true;
  cause?: unknown;
} {
  const err = new Error(ENGINE_BUSY_REFUNDED_MESSAGE) as Error & {
    refunded: true;
    cause?: unknown;
  };
  err.name = "EngineBusyRefundedError";
  err.refunded = true;
  err.cause = cause;
  return err;
}

export function isEngineBusyRefundedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && error !== null && "refunded" in error) {
    return Boolean((error as { refunded?: unknown }).refunded);
  }
  const text = error instanceof Error ? error.message : String(error);
  return text.includes(ENGINE_BUSY_REFUNDED_MESSAGE);
}

/** SSE dropped mid-render — client should short-poll Vault instead of crashing. */
export class StudioStreamDroppedError extends Error {
  readonly recoverable = true as const;
  constructor(message = "Generation stream dropped mid-render.") {
    super(message);
    this.name = "StudioStreamDroppedError";
  }
}

export function isStudioStreamDroppedError(error: unknown): error is StudioStreamDroppedError {
  return (
    error instanceof StudioStreamDroppedError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      (error as { name?: unknown }).name === "StudioStreamDroppedError")
  );
}

export function isDbLockOrUnexpectedSpendError(error: {
  message?: string;
  code?: string;
} | null): boolean {
  if (!error) return false;
  const code = (error.code ?? "").toUpperCase();
  if (code === "40001" || code === "40P01" || code === "55P03" || code === "57014") return true;
  const msg = (error.message ?? "").toLowerCase();
  return (
    msg.includes("lock") ||
    msg.includes("could not serialize") ||
    msg.includes("deadlock") ||
    msg.includes("statement timeout") ||
    msg.includes("canceling statement")
  );
}
