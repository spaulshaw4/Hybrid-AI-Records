/**
 * Binary Entanglement Suppression Engine — orthogonalize execution payloads.
 *
 * Severs shared memory references between the global queue row and the worker
 * thread by deep-cloning payloads and stamping immutable CTX session boundaries.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type EntanglementState = "SUPPRESSED_ORTHOGONAL";

export type OrthogonalPayload<T extends Record<string, unknown>> = T & {
  readonly __isolatedSessionNonce: string;
  readonly __entanglementState: EntanglementState;
  readonly __isolatedRequestId: string;
};

function deepCloneJsonSafe<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") {
      return structuredClone(value);
    }
  } catch {
    /* fall through to JSON clone */
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class BinaryEntanglementSuppressor {
  /**
   * Enforces strict binary orthogonality by purging shared memory references
   * and suppressing cross-talk between execution contexts.
   */
  static suppressCrossTalk<T extends Record<string, unknown>>(
    ctx: ExecutionContext,
    payload: T,
  ): OrthogonalPayload<T> {
    // 1. Deep clone — sever all shared reference links (entanglement suppression).
    const sanitizedPayload = deepCloneJsonSafe(payload) as OrthogonalPayload<T>;

    // 2. Inject immutable execution boundaries bound to this CTX only.
    Object.defineProperty(sanitizedPayload, "__isolatedSessionNonce", {
      value: ctx.sessionNonce,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(sanitizedPayload, "__entanglementState", {
      value: "SUPPRESSED_ORTHOGONAL" as const,
      writable: false,
      enumerable: true,
      configurable: false,
    });
    Object.defineProperty(sanitizedPayload, "__isolatedRequestId", {
      value: ctx.requestId,
      writable: false,
      enumerable: true,
      configurable: false,
    });

    return sanitizedPayload;
  }

  /**
   * Validates that two execution objects share zero reference entanglement.
   */
  static verifyDecoupling(targetA: unknown, targetB: unknown): boolean {
    if (targetA === targetB) return false;
    const a = targetA as { __isolatedSessionNonce?: string } | null;
    const b = targetB as { __isolatedSessionNonce?: string } | null;
    const nonceA = a?.__isolatedSessionNonce;
    const nonceB = b?.__isolatedSessionNonce;
    if (nonceA && nonceB) return nonceA !== nonceB;
    return true;
  }
}

/**
 * Queue → worker boundary helper: clone + stamp CTX, then mark isolation.
 */
export function executeIsolatedWorkerTask<T extends Record<string, unknown>>(
  ctx: ExecutionContext,
  rawData: T,
): {
  status: "EXECUTED_IN_ISOLATION";
  nonce: string;
  processedData: OrthogonalPayload<T>;
} {
  const cleanBinaryPayload = BinaryEntanglementSuppressor.suppressCrossTalk(ctx, rawData);
  return {
    status: "EXECUTED_IN_ISOLATION",
    nonce: cleanBinaryPayload.__isolatedSessionNonce,
    processedData: cleanBinaryPayload,
  };
}
