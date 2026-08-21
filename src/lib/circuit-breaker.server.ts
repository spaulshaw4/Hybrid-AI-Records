/**
 * Lightweight circuit breaker for upstream API routing.
 *
 * Three states per upstream key:
 *  - closed:     traffic flows normally, consecutive failures are counted.
 *  - open:       after 3 consecutive failures (or an immediate rate-limit /
 *                unavailable signal) the node is skipped for 60s and callers
 *                route to their fallback path.
 *  - half-open:  once the cooldown elapses exactly one probe request is let
 *                through. Success closes the breaker, failure re-opens it for
 *                another full cooldown window.
 */

import { sendSlackAlert } from "@/lib/slack-alert.server";

export type BreakerPhase = "closed" | "open" | "half-open";

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

/** Statuses that mean "upstream is shedding load" — trip immediately. */
export const TRIP_NOW_STATUSES = new Set([429, 502, 503, 504]);

type Entry = {
  failures: number;
  openedAt: number;
  /** True while a half-open probe is in flight. */
  probing: boolean;
  lastReason: string | null;
};

const registry = new Map<string, Entry>();

function entry(key: string): Entry {
  let found = registry.get(key);
  if (!found) {
    found = { failures: 0, openedAt: 0, probing: false, lastReason: null };
    registry.set(key, found);
  }
  return found;
}

export function breakerPhase(key: string, now = Date.now()): BreakerPhase {
  const state = registry.get(key);
  if (!state || state.openedAt === 0) return "closed";
  return now - state.openedAt >= BREAKER_COOLDOWN_MS ? "half-open" : "open";
}

/**
 * True when the upstream must be skipped. A half-open breaker allows exactly
 * one probe through; concurrent callers keep getting `true` until the probe
 * reports back.
 */
export function shouldSkip(key: string): boolean {
  const phase = breakerPhase(key);
  if (phase === "closed") return false;
  if (phase === "open") return true;
  const state = entry(key);
  if (state.probing) return true;
  state.probing = true; // this caller is the probe
  return false;
}

export function recordSuccess(key: string) {
  registry.delete(key);
}

export function recordFailure(key: string, status: number | null, reason?: string) {
  const state = entry(key);
  state.probing = false;
  state.lastReason = reason ?? (status !== null ? `HTTP ${status}` : "error");

  if (state.openedAt > 0) {
    // Half-open probe failed — re-open for another full cooldown.
    state.openedAt = Date.now();
    return;
  }

  state.failures += 1;
  if ((status !== null && TRIP_NOW_STATUSES.has(status)) || state.failures >= BREAKER_FAILURE_THRESHOLD) {
    state.openedAt = Date.now();
    console.error("[circuit-breaker] opened", {
      key,
      failures: state.failures,
      reason: state.lastReason,
    });
    void sendSlackAlert(`Circuit breaker opened for "${key}"`, state.lastReason);
  }
}

export function breakerSnapshot() {
  const now = Date.now();
  return [...registry.entries()].map(([key, state]) => ({
    key,
    phase: breakerPhase(key, now),
    failures: state.failures,
    retryAfterMs: state.openedAt ? Math.max(0, BREAKER_COOLDOWN_MS - (now - state.openedAt)) : 0,
    lastReason: state.lastReason,
  }));
}

export function resetBreakers() {
  registry.clear();
}
