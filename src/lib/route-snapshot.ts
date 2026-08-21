/**
 * Last-known-good loader data per route, kept in sessionStorage so an error
 * boundary can show *something* real when a retry fails again instead of a
 * dead end. Snapshots are tiny, best-effort and expire quickly — they are a
 * courtesy fallback, never a source of truth.
 */

const PREFIX = "har:route-snapshot:";
const MAX_BYTES = 60_000;
const TTL_MS = 30 * 60_000;

export type RouteSnapshot = {
  routeId: string;
  capturedAt: number;
  /** Flattened, display-safe key/value pairs from the loader payload. */
  fields: Array<{ label: string; value: string }>;
};

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value as object).length} fields`;
  return "—";
}

function toFields(data: unknown): Array<{ label: string; value: string }> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    const value = stringify(data);
    return value === "—" ? [] : [{ label: "Data", value }];
  }
  return Object.entries(data as Record<string, unknown>)
    .slice(0, 8)
    .map(([label, value]) => ({ label, value: stringify(value).slice(0, 160) }));
}

/** Records loader data for a route after a successful load. Never throws. */
export function recordRouteSnapshot(routeId: string, data: unknown): void {
  const store = storage();
  if (!store) return;
  try {
    const fields = toFields(data);
    if (fields.length === 0) return;
    const payload = JSON.stringify({ routeId, capturedAt: Date.now(), fields });
    if (payload.length > MAX_BYTES) return;
    store.setItem(PREFIX + routeId, payload);
  } catch {
    // Quota or serialization failure — snapshots are optional.
  }
}

/** Reads a fresh snapshot for a route, or null when there is none. */
export function readRouteSnapshot(routeId: string): RouteSnapshot | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + routeId);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RouteSnapshot;
    if (!parsed?.capturedAt || Date.now() - parsed.capturedAt > TTL_MS) {
      store.removeItem(PREFIX + routeId);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

const ATTEMPTS_PREFIX = "har:route-retry:";

/** How many times "Try again" has been pressed for a route since its last good load. */
export function readRetryAttempts(routeId: string): number {
  const store = storage();
  if (!store) return 0;
  const raw = store.getItem(ATTEMPTS_PREFIX + routeId);
  const parsed = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function writeRetryAttempts(routeId: string, attempts: number): void {
  const store = storage();
  if (!store) return;
  try {
    if (attempts <= 0) store.removeItem(ATTEMPTS_PREFIX + routeId);
    else store.setItem(ATTEMPTS_PREFIX + routeId, String(attempts));
  } catch {
    // Non-fatal.
  }
}

/**
 * Subscribes to resolved navigations and snapshots each match's loader data.
 * Returns an unsubscribe function.
 */
export function subscribeRouteSnapshots(router: {
  subscribe: (event: "onResolved", cb: () => void) => () => void;
  state: { matches: Array<{ routeId: string; loaderData?: unknown }> };
}): () => void {
  return router.subscribe("onResolved", () => {
    for (const match of router.state.matches) {
      writeRetryAttempts(match.routeId, 0);
      if (match.loaderData !== undefined) recordRouteSnapshot(match.routeId, match.loaderData);
    }
  });
}

