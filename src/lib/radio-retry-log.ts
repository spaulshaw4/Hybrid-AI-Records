/**
 * Retry attempt log for cross-device sync.
 *
 * Every time the listener presses Retry on the SyncBadge (or in the Sync
 * History panel), an attempt is opened here with a timestamp and this device's
 * identity. When the account round-trip settles, the same attempt is closed
 * with its outcome: a success (and how many tracks were reconciled, plus which
 * device won) or the specific error that came back. The log is kept in local
 * storage so the record survives reloads, and every write announces itself so
 * open panels re-render.
 */

/** Why a retry failed, derived from the error surfaced by the sync path. */
export type RetryErrorKind = "offline" | "network" | "auth" | "merge" | "no-account" | "unknown";

export type RetryAttempt = {
  /** Stable id so the settle call can find the attempt it opened. */
  id: string;
  /** When Retry was pressed (epoch ms). */
  at: number;
  /** Human label for the device that pressed Retry ("Chrome on macOS"). */
  device: string;
  /** Account the retry was made for, when known. */
  account?: string;
  outcome: "pending" | "success" | "error";
  /** When the attempt settled (epoch ms). */
  settledAt?: number;
  /** How long the account round-trip took. */
  durationMs?: number;
  /** Tracks reconciled by a successful attempt. */
  tracks?: number;
  /** Device whose action won the reconciliation, when a track changed. */
  wonBy?: string;
  /** Verbatim error message for a failed attempt. */
  error?: string;
  errorKind?: RetryErrorKind;
};

export const RETRY_LOG_KEY = "hybrid-radio-retry-log";
export const RETRY_LOG_EVENT = "hybrid-radio-retry-log";
export const RETRY_LOG_LIMIT = 25;

/** Buckets an error message into the reason shown next to the attempt. */
export function classifyRetryError(message: string): RetryErrorKind {
  const text = (message || "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("offline") || text.includes("no connection")) return "offline";
  if (text.includes("signed out") || text.includes("unauthorized") || text.includes("401")) return "auth";
  if (text.includes("no account") || text.includes("not signed in")) return "no-account";
  if (text.includes("compare playback timestamps")) return "merge";
  if (
    text.includes("reach your account") ||
    text.includes("network") ||
    text.includes("fetch") ||
    text.includes("timeout") ||
    text.includes("failed to load")
  ) {
    return "network";
  }
  return "unknown";
}

/** Short label for the outcome column. */
export const RETRY_ERROR_LABELS: Record<RetryErrorKind, string> = {
  offline: "Offline",
  network: "Network error",
  auth: "Signed out",
  merge: "Merge error",
  "no-account": "No account",
  unknown: "Failed",
};

export function readRetryLog(): RetryAttempt[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RETRY_LOG_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? (parsed as RetryAttempt[]) : [];
  } catch {
    return [];
  }
}

export function writeRetryLog(next: RetryAttempt[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RETRY_LOG_KEY, JSON.stringify(next.slice(0, RETRY_LOG_LIMIT)));
  } catch {
    /* storage full or blocked — the log is best-effort */
  }
  window.dispatchEvent(new CustomEvent(RETRY_LOG_EVENT));
}

/** Pure: prepends an opened attempt, newest first, within the limit. */
export function withAttempt(log: RetryAttempt[], attempt: RetryAttempt): RetryAttempt[] {
  return [attempt, ...log.filter((a) => a.id !== attempt.id)].slice(0, RETRY_LOG_LIMIT);
}

/**
 * Pure: closes an attempt with its outcome. Settling an attempt that is
 * already closed is a no-op, so a late duplicate callback can't rewrite the
 * recorded result.
 */
export function settleAttempt(
  log: RetryAttempt[],
  id: string,
  outcome: Omit<RetryAttempt, "id" | "at" | "device" | "outcome"> & { outcome: "success" | "error" },
): RetryAttempt[] {
  return log.map((a) => {
    if (a.id !== id || a.outcome !== "pending") return a;
    const settledAt = outcome.settledAt ?? Date.now();
    return { ...a, ...outcome, settledAt, durationMs: Math.max(0, settledAt - a.at) };
  });
}

/** Opens an attempt for this device and returns its id. */
export function startRetryAttempt(device: string, account?: string | null): string {
  const at = Date.now();
  const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
  writeRetryLog(
    withAttempt(readRetryLog(), {
      id,
      at,
      device,
      ...(account ? { account } : {}),
      outcome: "pending",
    }),
  );
  return id;
}

/** Closes the attempt with a successful reconciliation. */
export function finishRetryAttempt(id: string, tracks: number, wonBy?: string) {
  writeRetryLog(
    settleAttempt(readRetryLog(), id, {
      outcome: "success",
      tracks,
      ...(wonBy ? { wonBy } : {}),
    }),
  );
}

/** Closes the attempt with the specific error it hit. */
export function failRetryAttempt(id: string, message: string, kind?: RetryErrorKind) {
  writeRetryLog(
    settleAttempt(readRetryLog(), id, {
      outcome: "error",
      error: message,
      errorKind: kind ?? classifyRetryError(message),
    }),
  );
}
