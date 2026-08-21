/**
 * Baseline security headers applied to every server/edge response.
 * HSTS is only meaningful over https, but sending it unconditionally is safe:
 * browsers ignore it on plain http (localhost included).
 */
export const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

/** Adds the baseline headers to a Response without clobbering explicit ones. */
export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
}
