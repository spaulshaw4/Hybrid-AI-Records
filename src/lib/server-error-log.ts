/**
 * Structured server-side error logging. Dependency-free on purpose: it is
 * imported by the SSR wrapper, which must keep working even when app modules
 * fail to initialise.
 *
 * Every log line carries a reference id that is also shown on the error page,
 * so a user-reported reference maps to one exact stack trace in Server Logs.
 */

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
};

/** Short, sortable-ish id shown to the visitor and printed in the logs. */
export function newErrorReference(seed = ""): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const rand = Math.floor(Math.random() * 0xffff).toString(36);
  return `${Date.now().toString(36)}-${hash.toString(36)}-${rand}`.toUpperCase();
}

export function serializeError(error: unknown, depth = 0): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause:
        depth < 3 && error.cause !== undefined && error.cause !== null
          ? serializeError(error.cause, depth + 1)
          : undefined,
    };
  }
  if (error instanceof Response) {
    return {
      name: "Response",
      message: `Response ${error.status}${error.url ? ` at ${error.url}` : ""}`,
    };
  }
  if (error && typeof error === "object") {
    let message: string;
    try {
      message = JSON.stringify(error);
    } catch {
      message = String(error);
    }
    return { name: "UnknownObject", message };
  }
  return { name: "Unknown", message: String(error) };
}

export type RequestSummary = {
  method?: string;
  url?: string;
  referer?: string;
  userAgent?: string;
};

/** Safe, PII-light summary of the failing request. */
export function summarizeRequest(request?: Request): RequestSummary {
  if (!request) return {};
  let url = request.url;
  try {
    const parsed = new URL(request.url);
    // Query strings can carry tokens/emails — keep the path only.
    url = `${parsed.pathname}${parsed.search ? "?…" : ""}`;
  } catch {
    /* keep raw url */
  }
  return {
    method: request.method,
    url,
    referer: request.headers.get("referer") ?? undefined,
    userAgent: request.headers.get("user-agent")?.slice(0, 200) ?? undefined,
  };
}

/**
 * Logs one error with its full stack plus context. Emits both a structured
 * JSON line (greppable by reference) and the raw Error so the platform's log
 * viewer keeps the native stack.
 */
export function logServerError(
  error: unknown,
  context: { reference?: string; source: string; request?: Request } & Record<string, unknown>,
): string {
  const { reference = newErrorReference(context.source), source, request, ...rest } = context;
  const serialized = serializeError(error);

  try {
    console.error(
      `[server-error] ${reference} ${source}: ${serialized.name}: ${serialized.message}\n` +
        JSON.stringify(
          {
            reference,
            source,
            at: new Date().toISOString(),
            request: summarizeRequest(request),
            error: serialized,
            ...rest,
          },
          null,
          2,
        ),
    );
  } catch {
    /* never let logging throw */
  }

  // Raw error last so the runtime keeps the native stack association.
  if (error instanceof Error) console.error(error);

  return reference;
}
