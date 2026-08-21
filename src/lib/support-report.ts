import type { ErrorRouteContext } from "@/lib/error-context";

/** Records an error the visitor saw, plus whether they opened a support email. */
export type SupportEmailStatus = "not_sent" | "opened" | "sent" | "failed";

const sent = new Set<string>();

export function reportSupportContext(
  context: ErrorRouteContext,
  options: { message?: string; source?: string; emailStatus?: SupportEmailStatus } = {},
): void {
  if (typeof window === "undefined") return;

  const emailStatus = options.emailStatus ?? "not_sent";
  const key = `${context.reference}:${emailStatus}`;
  if (sent.has(key)) return;
  sent.add(key);

  const body = JSON.stringify({
    reference: context.reference,
    routeId: context.routeId,
    pathname: context.pathname,
    url: window.location.href,
    stage: context.stage,
    params: context.params,
    search: context.search,
    message: options.message?.slice(0, 500),
    source: options.source ?? "error-boundary",
    emailStatus,
  });

  try {
    if (emailStatus !== "not_sent" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon(
        "/api/public/support-reports",
        new Blob([body], { type: "application/json" }),
      );
      return;
    }
    void fetch("/api/public/support-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* reporting must never break the error page */
  }
}
