/**
 * Per-shot compute cost model (client-safe).
 *
 * A render is billed in V Tokens (1 token = 60s of finished runtime,
 * $12.50 each). The planner shows the producer, BEFORE anything is dispatched,
 * exactly what each camera block costs and what the whole project will cost.
 *
 * Lip-sync shots run a second model pass over the rendered clip, so they carry
 * a surcharge on top of the raw generation seconds.
 */

import { V_TOKEN_SECONDS } from "@/lib/v-tokens";

/** Retail price of one V Token, in USD. */
export const V_TOKEN_PRICE_USD = 12.5;

/** Extra billable seconds a lip-sync (Wav2Lip/SadTalker) pass adds per shot. */
export const LIPSYNC_SURCHARGE_SECONDS = 4;

export type ShotCost = {
  /** Raw generation seconds for the camera block. */
  seconds: number;
  /** Billable seconds including any lip-sync pass. */
  billableSeconds: number;
  /** Fractional V Tokens (the project total is what gets rounded up). */
  tokens: number;
  /** Estimated USD compute cost for this shot. */
  usd: number;
  lipSync: boolean;
};

/** Estimated compute cost of a single camera block. */
export function estimateShotCost(seconds: number, vocalSync = false): ShotCost {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const billableSeconds = safeSeconds + (vocalSync ? LIPSYNC_SURCHARGE_SECONDS : 0);
  const tokens = billableSeconds / V_TOKEN_SECONDS;
  return {
    seconds: safeSeconds,
    billableSeconds,
    tokens,
    usd: tokens * V_TOKEN_PRICE_USD,
    lipSync: vocalSync,
  };
}

export type ProjectCost = {
  shots: number;
  lipSyncShots: number;
  billableSeconds: number;
  /** Charged tokens — always whole tokens, rounded up. */
  tokens: number;
  usd: number;
};

/** Running project total shown at the top of the visual planner. */
export function estimateProjectCost(
  shots: Array<{ seconds: number; vocalSync?: boolean | undefined }>,
): ProjectCost {
  const costs = shots.map((s) => estimateShotCost(s.seconds, Boolean(s.vocalSync)));
  const billableSeconds = costs.reduce((sum, c) => sum + c.billableSeconds, 0);
  const tokens = billableSeconds > 0 ? Math.max(1, Math.ceil(billableSeconds / V_TOKEN_SECONDS)) : 0;
  return {
    shots: costs.length,
    lipSyncShots: costs.filter((c) => c.lipSync).length,
    billableSeconds,
    tokens,
    usd: tokens * V_TOKEN_PRICE_USD,
  };
}

/** "0.18 V · $2.29" style badge label for one shot. */
export function formatShotCost(cost: ShotCost): string {
  return `${cost.tokens.toFixed(2)} V · $${cost.usd.toFixed(2)}`;
}
