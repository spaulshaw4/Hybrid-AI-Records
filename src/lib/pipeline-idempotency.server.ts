/**
 * Coalesce duplicate studio generates for the same user+prompt.
 * Active in-process runs share one upstream execution instead of double-billing vendors.
 */

import { createHash } from "node:crypto";

export function buildGenerationIdempotencyKey(input: {
  userId: string;
  prompt: string;
  style?: string;
  lyrics?: string;
  instrumental?: boolean;
}): string {
  const material = [
    input.userId.trim(),
    input.prompt.trim().toLowerCase(),
    (input.style ?? "").trim().toLowerCase(),
    (input.lyrics ?? "").trim().toLowerCase(),
    input.instrumental ? "1" : "0",
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 48);
}

type ActiveRun = {
  promise: Promise<unknown>;
  startedAt: number;
  userId: string;
};

const activeRuns = new Map<string, ActiveRun>();

/** Pending token intents cleared on SIGTERM before settlement. */
const pendingTokenReservations = new Set<string>();

export function reserveGenerationTokenIntent(idempotencyKey: string): void {
  pendingTokenReservations.add(idempotencyKey);
}

export function clearGenerationTokenIntent(idempotencyKey: string): void {
  pendingTokenReservations.delete(idempotencyKey);
}

export function voidPendingTokenReservations(): number {
  const n = pendingTokenReservations.size;
  pendingTokenReservations.clear();
  if (n > 0) {
    console.warn(`[Idempotency] Voided ${n} pending token reservation(s) on shutdown`);
  }
  return n;
}

export function abortActiveGenerationRuns(): number {
  const n = activeRuns.size;
  activeRuns.clear();
  if (n > 0) {
    console.warn(`[Idempotency] Cleared ${n} active coalesced run(s) on shutdown`);
  }
  return n;
}

/**
 * If a run for `key` is already in flight, await that promise.
 * Otherwise start `fn` and register it until it settles.
 */
export async function coalesceGenerationRun<T>(
  key: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<{ value: T; coalesced: boolean; idempotencyKey: string }> {
  const existing = activeRuns.get(key);
  if (existing) {
    console.log(
      `[Idempotency] Attaching to in-flight generate key=${key.slice(0, 12)}… user=${userId}`,
    );
    const value = (await existing.promise) as T;
    return { value, coalesced: true, idempotencyKey: key };
  }

  const promise = fn().finally(() => {
    const cur = activeRuns.get(key);
    if (cur?.promise === promise) activeRuns.delete(key);
  });
  activeRuns.set(key, { promise, startedAt: Date.now(), userId });
  const value = await promise;
  return { value, coalesced: false, idempotencyKey: key };
}

export function __resetGenerationIdempotencyForTests(): void {
  activeRuns.clear();
  pendingTokenReservations.clear();
}
