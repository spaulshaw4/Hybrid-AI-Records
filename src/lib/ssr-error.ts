/**
 * Helpers for TanStack Start / h3 SSR failures.
 *
 * h3 converts an uncaught throw into HTTPError { unhandled: true } and then a
 * JSON 500 whose body is always {"status":500,"unhandled":true,"message":"HTTPError"}.
 * The original Error is on `.cause` (or `.cause.cause` when Node wraps it).
 */

export function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

/** 401/403/404/redirects that must not be turned into the branded 500 page. */
export function isIntentionalHttpResult(error: unknown): boolean {
  if (error instanceof Response) return true;
  if (!error || typeof error !== "object") return false;
  if ("unhandled" in error && (error as { unhandled?: unknown }).unhandled === true) {
    return false;
  }
  const status =
    "status" in error && typeof (error as { status: unknown }).status === "number"
      ? (error as { status: number }).status
      : "statusCode" in error && typeof (error as { statusCode: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
  return status !== null && status >= 300 && status < 500;
}

/** Walk h3's HTTPError wrapper to the Error that actually threw. */
export function unwrapSsrError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const httpish = error as Error & { unhandled?: unknown; cause?: unknown };
  if (httpish.unhandled !== true) return error;

  const cause = httpish.cause;
  if (cause instanceof Error) return cause;
  if (cause && typeof cause === "object" && "cause" in cause) {
    const nested = (cause as { cause?: unknown }).cause;
    if (nested !== undefined) return nested;
  }
  if (cause !== undefined) return cause;
  return error;
}
