/**
 * Local, persistent client error log.
 *
 * White screens on iOS are intermittent: by the time the user reports one, the
 * console is long gone. Every report shipped to the server is also kept here in
 * localStorage (a small ring buffer) so the same crash can be reviewed later on
 * the device it happened on, at /diagnostics.
 *
 * Best-effort only: storage may be full or blocked (Private Browsing), and this
 * module must never throw.
 */

export type ClientErrorSeverity = "fatal" | "non-fatal";

export type StoredClientError = {
  id: string;
  at: number;
  reference?: string;
  severity: ClientErrorSeverity;
  source: string;
  name: string;
  message: string;
  stack?: string;
  componentStack?: string;
  route?: string;
  url?: string;
  userAgent?: string;
  breadcrumbs?: string;
  extra?: Record<string, unknown>;
};

const KEY = "har_client_errors_v1";
const MAX_ENTRIES = 50;
const MAX_TEXT = 4_000;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function trim(value?: string): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, MAX_TEXT) : undefined;
}

export function readClientErrorLog(): StoredClientError[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredClientError[]) : [];
  } catch {
    return [];
  }
}

export function recordClientError(
  entry: Omit<StoredClientError, "id" | "at"> & { at?: number },
): StoredClientError | null {
  const store = storage();
  const stored: StoredClientError = {
    ...entry,
    stack: trim(entry.stack),
    componentStack: trim(entry.componentStack),
    breadcrumbs: trim(entry.breadcrumbs),
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    at: entry.at ?? Date.now(),
  };
  if (!store) return stored;
  try {
    const next = [stored, ...readClientErrorLog()].slice(0, MAX_ENTRIES);
    store.setItem(KEY, JSON.stringify(next));
  } catch {
    // Quota or blocked storage: drop older entries once, then give up.
    try {
      store.setItem(KEY, JSON.stringify([stored]));
    } catch {
      /* ignore */
    }
  }
  return stored;
}

export function clearClientErrorLog(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Short human reference shown to the visitor and logged server-side. */
export function newClientErrorReference(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `CL-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${rand}`;
}
