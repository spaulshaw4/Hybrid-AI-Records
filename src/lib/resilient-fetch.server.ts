/**
 * Resilient upstream fetch (server only).
 *
 * Every video / audio generation call goes through here so the render queue can
 * never be taken down by a transient network drop:
 *
 *  - Circuit breaker aware: the shared breaker in `circuit-breaker.server` is
 *    consulted before a request leaves. An open node throws `UpstreamSkipped`
 *    so the caller can route to its fallback path instead of burning time.
 *  - Timeout controls: a per-call abort deadline (generous by default — these
 *    are dispatch/poll calls, not long-running generation streams).
 *  - Automatic retry: network drops, "failed to fetch", timeouts and shedding
 *    statuses (429/502/503/504) are retried up to 2 extra times with
 *    exponential backoff + jitter.
 *  - Clear server logging: every attempt, retry and give-up is logged with the
 *    label, attempt number, status and elapsed time.
 *
 * The error is always bubbled up (never swallowed) once the retries are spent,
 * so the caller's fallback cascade decides what happens next.
 */

import {
  TRIP_NOW_STATUSES,
  recordFailure,
  recordSuccess,
  shouldSkip,
} from "@/lib/circuit-breaker.server";

/** Thrown when the breaker is open for this upstream — go to the fallback. */
export class UpstreamSkipped extends Error {
  constructor(public readonly key: string) {
    super(`Upstream "${key}" is cooling down after repeated failures.`);
    this.name = "UpstreamSkipped";
  }
}

/** Thrown when every attempt failed at the transport layer. */
export class UpstreamUnreachable extends Error {
  constructor(
    public readonly label: string,
    public readonly attempts: number,
    public readonly reason: string,
  ) {
    super(`${label}: upstream unreachable after ${attempts} attempt(s) — ${reason}`);
    this.name = "UpstreamUnreachable";
  }
}

export type ResilientOptions = {
  /** Human label used in logs and error text, e.g. "motion dispatch". */
  label: string;
  /** Circuit-breaker key — usually the model id or upstream host. */
  breakerKey?: string;
  /** Extra attempts after the first one. Default 0 — no automatic retries. */
  retries?: number;
  /** Abort deadline per attempt in ms. Default 120s. */
  timeoutMs?: number;
  /** First backoff delay; doubles each retry. Default 1200ms. */
  baseDelayMs?: number;
  /** Consult / update the shared breaker. Default true when a key is given. */
  useBreaker?: boolean;
  /** Honour an upstream `Retry-After` header before retrying (429s). */
  respectRetryAfter?: boolean;

};

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  const name = error.name;
  const message = error.message.toLowerCase();
  return (
    name === "TypeError" ||
    name === "AbortError" ||
    name === "TimeoutError" ||
    message.includes("failed to fetch") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("econnreset") ||
    message.includes("terminated")
  );
}

function backoff(attempt: number, baseDelayMs: number): number {
  const raw = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(15_000, Math.round(raw * (0.8 + Math.random() * 0.4)));
}

/** Upstream-suggested wait from a `Retry-After` header (seconds or HTTP date). */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(60_000, date - Date.now()));
  return null;
}


/**
 * Fetch with breaker awareness, timeout and exponential-backoff retries.
 * Resolves with the Response for any status the caller should interpret
 * (including 4xx); only transport failures and shedding statuses are retried.
 */
export async function resilientFetch(
  url: string,
  init: RequestInit,
  options: ResilientOptions,
): Promise<Response> {
  const {
    label,
    breakerKey,
    retries = 0,
    timeoutMs = 120_000,
    baseDelayMs = 1200,
    useBreaker = Boolean(breakerKey),
    respectRetryAfter = false,
  } = options;

  if (breakerKey && useBreaker && shouldSkip(breakerKey)) {
    console.warn(`[resilient-fetch] ${label}: breaker open for ${breakerKey} — routing to fallback`);
    throw new UpstreamSkipped(breakerKey);
  }

  const total = Math.max(1, retries + 1);
  let lastReason = "unknown error";

  // Native Google Generative Language requests authenticate through their URL
  // query parameter. Strip inherited/default bearer credentials defensively.
  const requestInit = { ...init };
  if (url.includes("generativelanguage.googleapis.com")) {
    const headers = new Headers(init.headers);
    headers.delete("Authorization");
    requestInit.headers = headers;
  }

  for (let attempt = 1; attempt <= total; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(url, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) });
      // A patched or aborted fetch can resolve undefined; reading `.ok` on it
      // would throw a bare TypeError instead of a readable pipeline error.
      if (!response) throw new Error("no response from server");
      const durationMs = Date.now() - startedAt;


      if (TRIP_NOW_STATUSES.has(response.status) && attempt < total) {
        lastReason = `HTTP ${response.status}`;
        const hinted = respectRetryAfter ? retryAfterMs(response) : null;
        const waitMs = hinted ?? backoff(attempt, baseDelayMs);
        console.warn(
          `[resilient-fetch] ${label}: ${lastReason} on attempt ${attempt}/${total} after ${durationMs}ms — retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }


      if (breakerKey && useBreaker) {
        if (response.ok) recordSuccess(breakerKey);
        else recordFailure(breakerKey, response.status);
      }
      console.info(
        `[resilient-fetch] ${label}: HTTP ${response.status} in ${durationMs}ms (attempt ${attempt}/${total})`,
      );
      return response;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const timedOut =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      lastReason = timedOut
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[resilient-fetch] ${label}: attempt ${attempt}/${total} failed after ${durationMs}ms — ${lastReason}`,
      );

      const retryable = isNetworkError(error);
      if (!retryable || attempt === total) {
        if (breakerKey && useBreaker) recordFailure(breakerKey, null, lastReason);
        throw new UpstreamUnreachable(label, attempt, lastReason);
      }
      await new Promise((r) => setTimeout(r, backoff(attempt, baseDelayMs)));
    }
  }

  if (breakerKey && useBreaker) recordFailure(breakerKey, null, lastReason);
  throw new UpstreamUnreachable(label, total, lastReason);
}
