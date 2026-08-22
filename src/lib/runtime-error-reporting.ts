import { reportClientError } from "./client-error-report";
import { captureAppException } from "./sentry-capture";

export function reportRuntimeError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  const message =
    error instanceof Response
      ? `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);

  console.error("[runtime]", message, error);

  reportClientError(error, {
    reference: typeof context.reference === "string" ? context.reference : undefined,
    source: typeof context.boundary === "string" ? context.boundary : "react_error_boundary",
    route: typeof context.routeId === "string" ? context.routeId : undefined,
    extra: context,
  });
  captureAppException(error, {
    tags: {
      source: typeof context.boundary === "string" ? context.boundary : "react_error_boundary",
    },
    extra: context,
  });
}
