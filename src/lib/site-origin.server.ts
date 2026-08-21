/**
 * Server-side allowlist for any URL we hand to a third party (Stripe redirects,
 * emailed resume links). Never trust a client-supplied origin.
 */

const EXACT_HOSTS = new Set([
  "hybrid-ai-records.com",
  "www.hybrid-ai-records.com",
  "hybrid-ai-studio.lovable.app",
]);

function isAllowedHost(hostname: string): boolean {
  if (EXACT_HOSTS.has(hostname)) return true;
  if (hostname === "localhost" || hostname === "127.0.0.1") return true;
  // Lovable preview/published deployments for this project only.
  if (hostname.endsWith(".lovable.app") && hostname.includes("hybrid-ai")) return true;
  return false;
}

/** Returns the canonical origin to use when no trusted candidate is available. */
export function defaultSiteOrigin(): string {
  return "https://hybrid-ai-records.com";
}

/** Returns the candidate origin if it is on the allowlist, otherwise null. */
export function allowedOrigin(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    return null;
  }
  if (!isAllowedHost(url.hostname)) return null;
  return url.origin;
}

/**
 * Validates a full URL (path + query preserved) against the origin allowlist.
 * Returns null when the URL points anywhere off-site.
 */
export function allowedSiteUrl(candidate: string | undefined | null): string | null {
  if (!candidate) return null;
  const origin = allowedOrigin(candidate);
  if (!origin) return null;
  return candidate;
}

/* ------------------------------------------------------------------ *
 * Redirect audit log
 * ------------------------------------------------------------------ */

export type RedirectSurface = "stripe_return_url" | "draft_resume_link";

export type RedirectDecision = {
  surface: RedirectSurface;
  /** Raw client-supplied value; sanitized before it reaches the log. */
  candidate: string | undefined | null;
  /** What we actually used (validated candidate or the fallback origin). */
  resolved: string | null;
  allowed: boolean;
  /** Optional correlation info, e.g. reference code or hashed email. */
  context?: Record<string, string | number | boolean | undefined>;
};

/**
 * Strips credentials, query strings and fragments so tokens, emails and
 * session ids never land in server logs. Unparseable input is truncated.
 */
function sanitizeForLog(value: string | undefined | null): string {
  if (!value) return "(empty)";
  try {
    const url = new URL(value);
    const auth = url.username || url.password ? "(userinfo-stripped) " : "";
    const query = url.search ? " ?(query-redacted)" : "";
    return `${auth}${url.protocol}//${url.host}${url.pathname}${query}`;
  } catch {
    return `(unparseable) ${value.slice(0, 120)}`;
  }
}

/**
 * Emits one structured line per redirect decision — allowed and blocked — so
 * resume links and Stripe return URLs can be audited in the server logs.
 */
export function auditRedirect(decision: RedirectDecision): void {
  const entry = {
    event: "redirect_decision",
    surface: decision.surface,
    outcome: decision.allowed ? "allowed" : "blocked",
    candidate: sanitizeForLog(decision.candidate),
    resolved: decision.resolved ? sanitizeForLog(decision.resolved) : null,
    at: new Date().toISOString(),
    ...(decision.context ?? {}),
  };
  const line = JSON.stringify(entry);
  if (decision.allowed) {
    console.info(line);
  } else {
    console.warn(line);
  }
}

/**
 * Validate + audit in one step. Returns the trusted origin, or the canonical
 * fallback when the candidate is missing or off-allowlist.
 */
export function resolveOriginWithAudit(
  candidate: string | undefined | null,
  surface: RedirectSurface,
  context?: RedirectDecision["context"],
): { origin: string; allowed: boolean } {
  const allowed = allowedOrigin(candidate);
  const origin = allowed ?? defaultSiteOrigin();
  auditRedirect({ surface, candidate, resolved: origin, allowed: Boolean(allowed), ...(context ? { context } : {}) });
  return { origin, allowed: Boolean(allowed) };
}

