/**
 * Clean abort for studio generate + poll loops.
 * User cancel must never surface as an unhandled rejection or trip a breaker.
 */

export const GENERATION_ABORTED_MESSAGE = "Render canceled. No Hybrid Tokens were charged.";

export class GenerationAbortedError extends Error {
  constructor(message = GENERATION_ABORTED_MESSAGE) {
    super(message);
    this.name = "GenerationAbortedError";
  }
}

export function isGenerationAborted(error: unknown): boolean {
  if (error instanceof GenerationAbortedError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return /canceled|cancelled|aborted/i.test(error.message);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GenerationAbortedError();
}

/** Timeout plus an optional user abort, without throwing if the user never cancels. */
export function mergeAbortSignals(
  timeoutMs: number,
  signal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const any = (AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof any === "function") return any([timeout, signal]);
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  if (signal.aborted || timeout.aborted) {
    abort();
    return controller.signal;
  }
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GenerationAbortedError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GenerationAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Rejects when the user cancels so a long server call can be dropped in the UI. */
export function abortableBarrier(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new GenerationAbortedError());
      return;
    }
    signal.addEventListener("abort", () => reject(new GenerationAbortedError()), { once: true });
  });
}
