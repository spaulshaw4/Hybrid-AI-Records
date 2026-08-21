/** Send an already-caught browser error to Sentry. Never throws. */
export function captureAppException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (typeof window === "undefined") return;
  void import("@sentry/react")
    .then((Sentry) => {
      Sentry.captureException(error, {
        tags: context?.tags,
        extra: context?.extra,
      });
    })
    .catch(() => undefined);
}
