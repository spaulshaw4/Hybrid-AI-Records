import { createServerFn } from "@tanstack/react-start";

/**
 * Live circuit-breaker status for both render engines.
 *
 * The browser uses this to warn an artist *before* they spend a token that an
 * engine is currently tripped, and to explain a failed render afterwards.
 * No inputs, no secrets — it only reports health counters.
 */
export type EngineBreakerStatus = {
  engine: "minimax" | "elevenlabs";
  open: boolean;
  failures: number;
  failureThreshold: number;
  retryAfterMs: number;
  lastReason: string | null;
};

export const getEngineBreakerStatus = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ engines: EngineBreakerStatus[]; checkedAt: number }> => {
    const { engineBreakerSnapshot } = await import("@/lib/engine-breaker.server");
    return { engines: engineBreakerSnapshot(), checkedAt: Date.now() };
  },
);
