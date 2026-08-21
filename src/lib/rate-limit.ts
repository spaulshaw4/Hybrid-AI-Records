/**
 * Best-effort in-process rate limiter.
 *
 * Generation, token-spend and auth-adjacent endpoints all cost real money
 * upstream, so a runaway client loop is capped here before any paid call is
 * made. The window is a simple sliding counter held per worker isolate — it is
 * a quota guard, not a security boundary (RLS and the DB idempotency keys are).
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 5000;

export type RateLimitOptions = {
  /** Stable caller identity: user id, ip, or `${fn}:${userId}`. */
  key: string;
  /** Max calls allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Human label used in the thrown message. */
  label?: string;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

function prune(now: number) {
  if (buckets.size < MAX_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function checkRateLimit(options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  prune(now);

  const existing = buckets.get(options.key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(options.key, { count: 1, resetAt: now + options.windowMs });
    return { allowed: true, remaining: options.limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > options.limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  return {
    allowed: true,
    remaining: options.limit - existing.count,
    retryAfterSeconds: 0,
  };
}

/** Throws a user-safe Error when the caller is over quota. */
export function enforceRateLimit(options: RateLimitOptions): void {
  const result = checkRateLimit(options);
  if (result.allowed) return;
  const what = options.label ?? "requests";
  throw new Error(
    `Too many ${what}. Wait ${result.retryAfterSeconds}s and try again.`,
  );
}

/** Preset windows so limits stay consistent across endpoints. */
export const RATE_LIMITS = {
  /** Paid AI/music/video generation dispatch. */
  generation: { limit: 8, windowMs: 60_000 },
  /** Token debits and download redemptions. */
  tokenSpend: { limit: 20, windowMs: 60_000 },
  /** Checkout/credit and auth-adjacent calls. */
  auth: { limit: 15, windowMs: 60_000 },
} as const;

/** Convenience helper: `limitBy("generateEngineTrack", userId, RATE_LIMITS.generation)`. */
export function limitBy(
  scope: string,
  identity: string,
  preset: { limit: number; windowMs: number },
  label?: string,
): void {
  enforceRateLimit({
    key: `${scope}:${identity}`,
    limit: preset.limit,
    windowMs: preset.windowMs,
    ...(label ? { label } : {}),
  });
}
