import * as Sentry from "@sentry/react";

/**
 * Browser-only Sentry init. Call from `src/client.tsx`, not from SSR routes.
 * Do not name this file `*.client.*` — TanStack Start will 500 GET / if an
 * SSR module imports that pattern (JAVASCRIPT-NEXTJS-1).
 */
export function initBrowserSentry(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
    // Facebook / Instagram Android In-App Browser injects iabjs telemetry that
    // throws on close via the native postMessage bridge — not our app code.
    ignoreErrors: [
      "Error invoking postMessage",
      "sendDataToNative",
      "navigation_performance_logger_android",
      /sendBeforeUnloadMessage/i,
      /_handleBrowserPreparingToClose/i,
    ],
    denyUrls: [
      /iabjs:\/\//i,
      /navigation_performance_logger_android/i,
    ],
    beforeSend(event) {
      const values = event.exception?.values ?? [];
      const blob = [
        event.message,
        ...values.map((v) => `${v.type ?? ""} ${v.value ?? ""}`),
        ...values.flatMap(
          (v) => v.stacktrace?.frames?.map((f) => f.filename ?? "") ?? [],
        ),
      ]
        .filter(Boolean)
        .join("\n");
      if (
        /iabjs:\/\//i.test(blob) ||
        /navigation_performance_logger_android/i.test(blob) ||
        /sendDataToNative/i.test(blob) ||
        /Error invoking postMessage/i.test(blob)
      ) {
        return null;
      }
      return event;
    },
  });
}
