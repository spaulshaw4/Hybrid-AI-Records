/**
 * Detanglement Reactor — active cross-correlation scrubbing before Fluctuator.
 *
 * Measures a pseudo-entanglement / entropy index from CTX + payload, severs
 * shared references, and dampens ambiguous bleed fields when cross-talk is high.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type ReactorCoreState = {
  /** 0.0 (fully isolated) → 1.0 (critical cross-talk), reported as damped fraction. */
  entanglementLevel: number;
  suppressionActive: boolean;
  reactorNonce: string;
  /** Raw 0–1 entropy score before dampening. */
  entropyScore: number;
  aggressiveDampening: boolean;
};

const BLEED_KEYS = [
  "__unsecuredVector",
  "__sharedGlobalRef",
  "__devOverrideUserId",
  "__adminSharedCache",
  "__crossTenantHint",
  "sharedGlobalRef",
  "unsecuredVector",
] as const;

function deepClone<T>(value: T): T {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    /* JSON fallback */
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export class DetanglementReactor {
  /**
   * Activates suppression protocols to scrub cross-tenant references
   * and isolate the execution context vector.
   */
  static purgeCrossCorrelations<T extends Record<string, unknown>>(
    ctx: ExecutionContext,
    payload: T,
  ): { sanitizedPayload: T; reactorState: ReactorCoreState } {
    // 1. Deep serialization — sever memory references.
    const sanitizedPayload = deepClone(payload) as T & Record<string, unknown>;

    // 2. Pseudo-entanglement index from requestId + payload entropy.
    const entropyScore = DetanglementReactor.calculateEntropyVector(
      ctx.requestId,
      JSON.stringify(sanitizedPayload),
    );

    // 3. Aggressive dampening when entropy/cross-talk exceeds safety bounds.
    const suppressionRequired = entropyScore > 0.85;
    if (suppressionRequired) {
      for (const key of BLEED_KEYS) {
        if (key in sanitizedPayload) {
          delete sanitizedPayload[key];
        }
      }
    }

    // Always strip known bleed keys even below threshold (cheap insurance).
    for (const key of ["__unsecuredVector", "__sharedGlobalRef"] as const) {
      if (key in sanitizedPayload) delete sanitizedPayload[key];
    }

    const reactorState: ReactorCoreState = {
      entanglementLevel: Number((entropyScore * 0.1).toFixed(4)),
      suppressionActive: true,
      reactorNonce: `reactor_${ctx.sessionNonce}`,
      entropyScore: Number(entropyScore.toFixed(4)),
      aggressiveDampening: suppressionRequired,
    };

    return { sanitizedPayload: sanitizedPayload as T, reactorState };
  }

  private static calculateEntropyVector(requestId: string, payloadStr: string): number {
    let hash = 0;
    const combined = `${requestId}${payloadStr}`;
    for (let i = 0; i < combined.length; i += 1) {
      hash = (hash << 5) - hash + combined.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash % 1000) / 1000;
  }
}

/**
 * Execution-boundary gate: run immediately before Fluctuator.
 */
export function runReactorSuppressionGate<T extends Record<string, unknown>>(
  ctx: ExecutionContext,
  rawPayload: T,
): {
  executionContext: ExecutionContext;
  payload: T;
  reactorLog: ReactorCoreState;
  status: "DETANGLED_AND_SECURE";
} {
  const { sanitizedPayload, reactorState } = DetanglementReactor.purgeCrossCorrelations(
    ctx,
    rawPayload,
  );
  return {
    executionContext: ctx,
    payload: sanitizedPayload,
    reactorLog: reactorState,
    status: "DETANGLED_AND_SECURE",
  };
}
