/**
 * Ships browser crashes (with stack traces) to /api/public/client-errors so
 * they appear in Server Logs alongside SSR failures, keyed by the same error
 * reference the visitor sees on the error page.
 */

import { addBreadcrumb, deviceContext, formatBreadcrumbs } from "./client-breadcrumbs";
import { getPerfSummary } from "./perf-watch";
import {
  newClientErrorReference,
  recordClientError,
  type ClientErrorSeverity,
} from "./client-error-log";

const ENDPOINT = "/api/public/client-errors";
const MAX_PER_SESSION = 20;
const DEDUPE_MS = 10_000;

let sent = 0;
const recent = new Map<string, number>();

export type ClientErrorReport = {
  reference?: string;
  source: string;
  route?: string;
  componentStack?: string;
  /** "non-fatal" = the boundary recovered the session; still worth tracking. */
  severity?: ClientErrorSeverity;
  extra?: Record<string, unknown>;
};

function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof Response !== "undefined" && error instanceof Response) {
    return {
      name: "Response",
      message: `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`,
    };
  }
  return { name: "Unknown", message: String(error) };
}

export function reportClientError(error: unknown, info: ClientErrorReport): string | undefined {
  if (typeof window === "undefined") return undefined;
  if (sent >= MAX_PER_SESSION) return undefined;

  const described = describe(error);
  addBreadcrumb("error", `${described.name}: ${described.message}`, { source: info.source });
  const key = `${info.source}|${described.name}|${described.message}`;
  const now = Date.now();
  const last = recent.get(key);
  if (last && now - last < DEDUPE_MS) return undefined;
  recent.set(key, now);
  sent += 1;

  const reference = info.reference ?? newClientErrorReference();
  const severity = info.severity ?? "fatal";
  const route = info.route ?? window.location.pathname;
  const breadcrumbs = formatBreadcrumbs();
  // Correlate the crash with the runtime performance timeline: on iOS a blank
  // screen is almost always preceded by stalls, dropped frames or heap growth.
  const perf = getPerfSummary();
  const extra = { ...deviceContext(), severity, perf, ...info.extra };

  // Persist locally first: intermittent iOS white screens are often reported
  // days later, and this is the only copy tied to the affected device.
  recordClientError({
    reference,
    severity,
    source: info.source,
    name: described.name,
    message: described.message,
    stack: described.stack,
    componentStack: info.componentStack,
    route,
    url: window.location.href,
    userAgent: navigator.userAgent,
    breadcrumbs,
    extra: info.extra,
  });

  const body = JSON.stringify({
    ...described,
    reference,
    source: info.source,
    route,
    url: window.location.href,
    componentStack: info.componentStack,
    userAgent: navigator.userAgent,
    // Sentry-style context: what the visitor did just before the crash, and
    // what kind of device/viewport state they were in (iOS chrome gap, PWA
    // standalone mode, orientation). Both are essential for white screens.
    breadcrumbs,
    extra,
  });

  try {
    // keepalive so the report survives a navigation or reload right after the crash.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* reporting must never throw */
  }

  return reference;
}

let installed = false;

/** Installs window-level listeners once, from a client effect. */
export function installClientErrorReporting(): void {
  if (typeof window === "undefined" || installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    // Failed subresources (chunks, audio, images) surface here with no Error
    // object; on iOS a missing JS chunk is a common white-screen cause.
    const target = event.target as (HTMLElement & { src?: string; href?: string }) | null;
    if (target && target !== (window as unknown as EventTarget) && target.tagName) {
      addBreadcrumb("resource", `load-failed:${target.tagName}`, {
        url: String(target.src ?? target.href ?? "").slice(0, 120),
      });
    }
    reportClientError(event.error ?? new Error(event.message), {
      source: "window.onerror",
      extra: {
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(event.reason, { source: "unhandledrejection" });
  });
}
