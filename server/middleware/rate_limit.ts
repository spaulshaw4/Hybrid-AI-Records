import { createError, defineEventHandler, getHeader, getRequestURL, setResponseHeader } from "h3";
import {
  checkWorkstationRateLimit,
  type WorkstationRateScope,
} from "../../src/lib/rate-limit.server";

/**
 * Leftover Nitro/h3 hook. TanStack Start already calls `enforceRateLimit` on
 * execute / stem upload / signed-url. Enable this file only when Nitro is the
 * sole gateway (`HYBRID_H3_RATE_LIMIT=1`) so the same bucket is not spent twice.
 *
 * In-memory buckets are per-process. Identity is `x-user-id` (same as the
 * shared helper). `x-forwarded-for` is not used.
 */
const HOT_ROUTES: { prefix: string; methods: string[]; scope: WorkstationRateScope }[] = [
  { prefix: "/api/master/execute", methods: ["POST"], scope: "execute" },
  { prefix: "/api/pipeline/master", methods: ["POST"], scope: "execute" },
  { prefix: "/api/stems/upload", methods: ["POST"], scope: "upload" },
  { prefix: "/api/storage/signed-url", methods: ["POST"], scope: "signedUrl" },
];

function resolveScope(pathname: string, method: string): WorkstationRateScope | null {
  for (const route of HOT_ROUTES) {
    if (pathname.startsWith(route.prefix) && route.methods.includes(method)) {
      return route.scope;
    }
  }
  return null;
}

export default defineEventHandler((event) => {
  if (process.env.HYBRID_H3_RATE_LIMIT !== "1") return;

  const url = getRequestURL(event);
  const pathname = url.pathname || event.node.req.url?.split("?")[0] || "";
  const method = (event.node.req.method || "GET").toUpperCase();
  const scope = resolveScope(pathname, method);
  if (!scope) return;

  const result = checkWorkstationRateLimit((name) => getHeader(event, name), scope);
  if (result.allowed) return;

  setResponseHeader(event, "Retry-After", String(result.retryAfter));
  throw createError({
    statusCode: 429,
    statusMessage: "Too many requests",
    data: { error: "Too many requests", retryAfter: result.retryAfter },
  });
});
