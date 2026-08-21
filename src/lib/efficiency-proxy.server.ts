/**
 * Efficiency proxy for the Hybrid Engine 1.0 render pipeline.
 *
 * Sits in front of the MiniMax 2.6 dispatch and does three things, all of
 * which save real money on duplicate or runaway renders:
 *
 *   1. Fingerprint dedupe — identical brief + lyrics + language + mode inside
 *      the TTL window returns the previous task instead of paying for a second
 *      render of the same song.
 *   2. In-flight coalescing — the double-tap / retry-storm case. Concurrent
 *      identical requests share one upstream call and one result.
 *   3. Rate limiting — a per-user sliding window plus a global concurrency cap,
 *      so one account (or one stuck client loop) cannot drain the render
 *      credits for everyone.
 *
 * Dedupe runs on two tiers: an in-memory map for the hot path plus a shared
 * Supabase-backed cache so the same brief is recognised across worker
 * instances and survives restarts. Rate limiting and in-flight coalescing stay
 * per-instance: they are a cost optimisation, not a correctness boundary. Token accounting, entitlement and
 * RLS all stay where they are.
 */

import { createHash } from "crypto";
import {
  purgeSharedProxyCache,
  readSharedProxyCache,
  writeSharedProxyCache,
} from "./proxy-cache.server";

export type ProxyFingerprintInput = {
  prompt: string;
  lyrics: string;
  style?: string;
  language?: string;
  customLanguage?: string;
  instrumental?: boolean;
  model?: string;
  audioFormat?: string;
  /** Render engine id — different engines never share a cached render. */
  engine?: string;
  /** Requested length in seconds, when the engine takes an explicit duration. */
  durationSeconds?: number;
};


/** Per-user sliding window: starts allowed per window. */
export const RATE_LIMIT_MAX = 6;
export const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
/** How long a completed render stays deduplicable. */
export const CACHE_TTL_MS = 30 * 60_000;
/** Hard ceiling on simultaneous upstream renders across the instance. */
export const MAX_CONCURRENT_RENDERS = 8;
const MAX_CACHE_ENTRIES = 200;

type CacheEntry<T> = { value: T; expiresAt: number };

const resultCache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const userHits = new Map<string, number[]>();
let activeRenders = 0;

/**
 * The shared tier. Swappable so unit tests can exercise cross-instance
 * behaviour without a database round trip.
 */
export type SharedProxyStore = {
  read: (fingerprint: string, now: number) => Promise<unknown | null>;
  write: (fingerprint: string, value: unknown, expiresAt: number) => Promise<void>;
  purge?: (now: number) => Promise<void>;
};

const supabaseSharedStore: SharedProxyStore = {
  read: (fingerprint, now) => readSharedProxyCache(fingerprint, now),
  write: writeSharedProxyCache,
  purge: purgeSharedProxyCache,
};

let sharedStore: SharedProxyStore | null = supabaseSharedStore;

/** Swap or disable (pass null) the cross-instance cache tier. */
export function setSharedProxyStore(store: SharedProxyStore | null): void {
  sharedStore = store;
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Stable fingerprint for a render request. Normalised so trivial whitespace or
 * casing differences in the brief still collapse onto one cache key, while any
 * real change to the words, language, or mode produces a new one.
 */
export function requestFingerprint(req: ProxyFingerprintInput): string {
  const norm = (v: string | undefined) =>
    (v ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
  const parts = [
    norm(req.prompt),
    // Lyrics keep their case: capitalisation is part of the sung text.
    (req.lyrics ?? "").normalize("NFC").replace(/[ \t]+/g, " ").trim(),
    norm(req.style),
    norm(req.language) || "auto",
    norm(req.customLanguage),
    req.instrumental === true ? "inst" : "vocal",
    norm(req.model),
    norm(req.audioFormat) || "mp3",
    norm(req.engine) || "minimax",
    String(req.durationSeconds ?? ""),
  ];

  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 48);
}

function pruneCache(now: number) {
  for (const [key, entry] of resultCache) {
    if (entry.expiresAt <= now) resultCache.delete(key);
  }
  while (resultCache.size > MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** Records a start for this user, throwing when the window is exhausted. */
export function enforceRateLimit(userId: string, now = Date.now()): void {
  const hits = (userHits.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    const oldest = hits[0] ?? now;
    const retryAfterMs = Math.max(1000, RATE_LIMIT_WINDOW_MS - (now - oldest));
    userHits.set(userId, hits);
    throw new RateLimitError(
      `Too many renders started in a short window. Try again in about ${Math.ceil(
        retryAfterMs / 60_000,
      )} minute(s).`,
      retryAfterMs,
    );
  }
  hits.push(now);
  userHits.set(userId, hits);
}

export type ProxyOutcome<T> = {
  /** True when the result came from the dedupe cache or a shared in-flight run. */
  cached: boolean;
  fingerprint: string;
  value: T;
};

/**
 * Runs `dispatch` behind the cache, the in-flight coalescer and the limiters.
 * `dispatch` is only invoked on a genuine miss.
 */
export async function runThroughEfficiencyProxy<T>(args: {
  userId: string;
  request: ProxyFingerprintInput;
  dispatch: () => Promise<T>;
  /** Return false to keep a result out of the cache (e.g. failed renders). */
  cacheable?: (value: T) => boolean;
  now?: number;
}): Promise<ProxyOutcome<T>> {
  const now = args.now ?? Date.now();
  const fingerprint = requestFingerprint(args.request);
  pruneCache(now);

  const hit = resultCache.get(fingerprint);
  if (hit && hit.expiresAt > now) {
    return { cached: true, fingerprint, value: hit.value as T };
  }

  // Miss locally: another instance (or this one before a restart) may already
  // have rendered this exact brief.
  if (sharedStore) {
    // The shared tier is an optimisation: a failing store degrades to a miss.
    const shared = await sharedStore.read(fingerprint, now).catch(() => null);
    if (shared !== null && shared !== undefined) {
      resultCache.set(fingerprint, { value: shared, expiresAt: now + CACHE_TTL_MS });
      return { cached: true, fingerprint, value: shared as T };
    }
  }

  const pending = inFlight.get(fingerprint);
  if (pending) {
    return { cached: true, fingerprint, value: (await pending) as T };
  }

  // Limits apply only to work that will actually hit the engine.
  enforceRateLimit(args.userId, now);
  if (activeRenders >= MAX_CONCURRENT_RENDERS) {
    throw new RateLimitError("The engine is at capacity right now. Try again in a moment.", 15_000);
  }

  activeRenders += 1;
  const run = (async () => {
    try {
      const value = await args.dispatch();
      const keep = args.cacheable ? args.cacheable(value) : true;
      if (keep) {
        const expiresAt = now + CACHE_TTL_MS;
        resultCache.set(fingerprint, { value, expiresAt });
        if (sharedStore) {
          // Fire and forget: persisting the entry must not delay the render.
          void Promise.resolve(sharedStore.write(fingerprint, value, expiresAt)).catch(
            () => undefined,
          );
          // Occasional sweep keeps the shared table from growing unbounded.
          if (Math.random() < 0.05) {
            void Promise.resolve(sharedStore.purge?.(now)).catch(() => undefined);
          }
        }
      }
      return value;
    } finally {
      activeRenders -= 1;
      inFlight.delete(fingerprint);
    }
  })();
  inFlight.set(fingerprint, run);

  return { cached: false, fingerprint, value: (await run) as T };
}

/** Test/ops helper: clears all proxy state. */
export function resetEfficiencyProxy(): void {
  sharedStore = supabaseSharedStore;
  resultCache.clear();
  inFlight.clear();
  userHits.clear();
  activeRenders = 0;
}

export function efficiencyProxyStats() {
  return {
    cachedEntries: resultCache.size,
    inFlight: inFlight.size,
    activeRenders,
    trackedUsers: userHits.size,
    sharedTier: sharedStore ? "supabase" : "disabled",
  };
}
