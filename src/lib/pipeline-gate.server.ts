/**
 * Per-gate circuit breakers for the 6-gate studio pipeline.
 * Races each cloud call against a hard deadline so a hung vendor cannot freeze the shell.
 */

export const GATE_TIMEOUTS_MS = {
  1: 120_000, // AIMusicAPI base generation
  2: 30_000, // Supabase vault upload + public URL verify
  3: 60_000, // CWALO Replicate (soft-fail)
  4: 90_000, // Demucs separation + stem checks
  5: 60_000, // Fish Audio conversion
  6: 60_000, // FFmpeg mastering + master Supabase upload
} as const;

export type StudioGateId = 1 | 2 | 3 | 4 | 5 | 6;

const GATE_LABELS: Record<StudioGateId, string> = {
  1: "AIMusicAPI generation",
  2: "Supabase vault isolation",
  3: "CWALO structure analysis",
  4: "Demucs stem separation",
  5: "Fish Audio voice conversion",
  6: "FFmpeg mastering + final commit",
};

export function gateTimeoutMs(gate: StudioGateId): number {
  return GATE_TIMEOUTS_MS[gate];
}

/** @deprecated Use GATE_TIMEOUTS_MS[gate] — kept for older imports. */
export const GATE_TIMEOUT_MS = GATE_TIMEOUTS_MS[3];
/** @deprecated Use GATE_TIMEOUTS_MS[1] */
export const GATE_1_MUSIC_TIMEOUT_MS = GATE_TIMEOUTS_MS[1];

export function logGateStarting(gate: StudioGateId, detail?: string): void {
  console.log(`[Gate ${gate}/6] Starting ${GATE_LABELS[gate]}${detail ? ` — ${detail}` : ""}`);
}

/** @deprecated Prefer logGateStarting */
export function logGateDispatched(gate: StudioGateId, detail?: string): void {
  logGateStarting(gate, detail);
}

export function logGateFinished(gate: StudioGateId, detail?: string): void {
  console.log(`[Gate ${gate}/6] Finished ${GATE_LABELS[gate]}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Circuit breaker: race `promise` against `ms`. Clears the timer on settle.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, stepName: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      console.error(`[Circuit Breaker] ${stepName} timed out after ${ms / 1000}s`);
      reject(new Error(`[Circuit Breaker] ${stepName} timed out after ${ms / 1000}s`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Gate-scoped timeout using the default budget for that gate. */
export async function withGateTimeout<T>(
  gate: StudioGateId,
  work: Promise<T>,
  timeoutMs: number = gateTimeoutMs(gate),
): Promise<T> {
  return withTimeout(work, timeoutMs, `Gate ${gate}/6 (${GATE_LABELS[gate]})`);
}
