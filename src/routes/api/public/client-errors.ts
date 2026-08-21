import { createFileRoute } from "@tanstack/react-router";
import { logServerError, newErrorReference } from "@/lib/server-error-log";

/**
 * Collects browser-side crashes (error boundaries, window.onerror, unhandled
 * rejections) so client stack traces land in the same Server Logs stream as
 * SSR failures. Public by necessity — the browser has no session on a crash —
 * so the payload is strictly size-capped, shape-validated, and never trusted
 * for anything but logging.
 */

const MAX_BODY_BYTES = 16_000;
const MAX_STACK = 6_000;

type ClientErrorPayload = {
  reference?: string;
  message?: string;
  stack?: string;
  name?: string;
  source?: string;
  route?: string;
  url?: string;
  componentStack?: string;
  breadcrumbs?: string;
  userAgent?: string;
  extra?: Record<string, unknown>;
};

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, max);
}

export const Route = createFileRoute("/api/public/client-errors")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const raw = await request.text();
        if (raw.length > MAX_BODY_BYTES) {
          return new Response("Payload too large", { status: 413 });
        }

        let payload: ClientErrorPayload;
        try {
          payload = JSON.parse(raw) as ClientErrorPayload;
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        if (!payload || typeof payload !== "object") {
          return new Response("Invalid payload", { status: 400 });
        }

        const message = clean(payload.message, 500) ?? "Unknown client error";
        const reference = clean(payload.reference, 64) ?? newErrorReference(message);

        const error = new Error(message);
        error.name = clean(payload.name, 100) ?? "ClientError";
        error.stack = clean(payload.stack, MAX_STACK) ?? `${error.name}: ${message}`;

        logServerError(error, {
          reference,
          source: `client:${clean(payload.source, 60) ?? "unknown"}`,
          request,
          clientRoute: clean(payload.route, 300),
          clientUrl: clean(payload.url, 500),
          componentStack: clean(payload.componentStack, MAX_STACK),
          breadcrumbs: clean(payload.breadcrumbs, 4_000),
          clientUserAgent: clean(payload.userAgent, 200),
          extra: payload.extra && typeof payload.extra === "object" ? payload.extra : undefined,
        });

        return Response.json({ ok: true, reference });
      },
    },
  },
});
