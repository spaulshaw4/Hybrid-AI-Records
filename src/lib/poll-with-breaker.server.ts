/**
 * Bounded async poller for the 6-gate studio pipeline.
 * Caps attempts so AIMusicAPI / Replicate status loops cannot hang Node indefinitely.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const POLL_BREAKER_DEFAULTS = {
  maxAttempts: 30,
  intervalMs: 2000,
} as const;

export type PollWithBreakerOptions = {
  maxAttempts?: number;
  intervalMs?: number;
  /** Shown in logs as `[Polling <stepName>] Attempt X/30...` */
  stepName?: string;
  /** Attached to the thrown breaker error for UI step sync (e.g. `composition`). */
  step?: string;
};

/**
 * Poll `fn` until `validate` passes, a terminal error is detected, or max attempts.
 * Uses setTimeout sleeps only — never busy-waits the event loop.
 */
export async function pollWithBreaker<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  isTerminalError: (result: T) => boolean,
  options: PollWithBreakerOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? POLL_BREAKER_DEFAULTS.maxAttempts;
  const intervalMs = options.intervalMs ?? POLL_BREAKER_DEFAULTS.intervalMs;
  const stepName = options.stepName ?? "Polling Task";
  const logLabel = stepName.startsWith("Polling ") ? stepName : `Polling ${stepName}`;

  let attempts = 0;
  while (attempts < maxAttempts) {
    attempts += 1;
    console.log(`[${logLabel}] Attempt ${attempts}/${maxAttempts}...`);

    const result = await fn();
    if (validate(result)) {
      return result;
    }
    if (isTerminalError(result)) {
      const err = new Error(
        `[${logLabel}] Failed with terminal error response.`,
      ) as Error & { step?: string };
      if (options.step) err.step = options.step;
      throw err;
    }
    if (attempts < maxAttempts) {
      await sleep(intervalMs);
    }
  }

  const err = new Error(
    `[${logLabel}] Breaker tripped: Exceeded max attempts (${maxAttempts}).`,
  ) as Error & { step?: string };
  if (options.step) err.step = options.step;
  throw err;
}

/** True for Replicate / vendor statuses that must abort the poll immediately. */
export function isTerminalPollStatus(status: string | null | undefined): boolean {
  const value = (status ?? "").trim().toLowerCase();
  return (
    value === "failed" ||
    value === "canceled" ||
    value === "cancelled" ||
    value === "aborted" ||
    value === "error"
  );
}

/** True for HTTP responses that must abort the poll immediately. */
export function isTerminalHttpStatus(status: number): boolean {
  return status >= 400;
}
