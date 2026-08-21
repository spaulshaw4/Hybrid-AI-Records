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
  });
}
