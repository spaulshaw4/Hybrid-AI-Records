/**
 * WebKit Safe Mode.
 *
 * iOS Safari degrades in a very specific way: when the compositor runs out of
 * accelerated layers (rotating crest background + blurred glass panels + a
 * portalled overlay) it does not throw — it paints a white or black screen, or
 * the render tree blows up and our error boundary recovers into a stub.
 *
 * Safe Mode is the automatic response. Every white-screen detection, boundary
 * recovery or blank-after-resume event is recorded to a small rolling incident
 * log in localStorage. Once the device produces enough of them inside one
 * window, we flip `<html data-safe-mode="on">`, which the stylesheet uses to
 * strip *all* decorative animation, translucency and GPU-layer promotion for
 * this device, permanently, until the user turns it back off from
 * /diagnostics. Content and functionality are untouched — only the expensive
 * decoration goes away.
 *
 * Everything here is best-effort and must never throw: this module runs on the
 * exact code path that is already failing.
 */

import { addBreadcrumb } from "./client-breadcrumbs";

export type IncidentKind =
  | "white-screen"
  | "boundary-recovery"
  | "overlay-collapse"
  | "manual";

export type SafeModeReason = IncidentKind | "user" | "jank";

export type SafeModeState = {
  active: boolean;
  /** Set when Safe Mode was turned on by the detector rather than the user. */
  auto: boolean;
  reason?: SafeModeReason;
  since?: number;
  /** Incidents recorded inside the current detection window. */
  incidents: number;
};

const STATE_KEY = "hybrid:webkit-safe-mode";
const LOG_KEY = "hybrid:webkit-safe-mode:incidents";
const ATTR = "data-safe-mode";

/** Incidents required inside WINDOW_MS before Safe Mode engages. */
export const INCIDENT_THRESHOLD = 2;
/** Rolling window for repeated failures (one browsing session-ish). */
export const WINDOW_MS = 30 * 60 * 1000;
/** Hard cap on stored incidents so the log can never grow unbounded. */
const MAX_INCIDENTS = 20;

type Incident = { t: number; kind: IncidentKind };

let state: SafeModeState = { active: false, auto: false, incidents: 0 };
const listeners = new Set<(state: SafeModeState) => void>();
let hydrated = false;

function safeRead<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — Safe Mode still applies for this page life */
  }
}

function readIncidents(): Incident[] {
  const cutoff = Date.now() - WINDOW_MS;
  const list = safeRead<Incident[]>(LOG_KEY) ?? [];
  return Array.isArray(list) ? list.filter((i) => i && typeof i.t === "number" && i.t > cutoff) : [];
}

function applyAttribute(): void {
  try {
    const root = document.documentElement;
    if (state.active) root.setAttribute(ATTR, "on");
    else root.removeAttribute(ATTR);
  } catch {
    /* ignore */
  }
}

function emit(): void {
  applyAttribute();
  for (const listener of [...listeners]) {
    try {
      listener(state);
    } catch {
      /* a broken subscriber must not break recovery */
    }
  }
}

/** Reads persisted state and applies the attribute. Safe to call repeatedly. */
export function initSafeMode(): SafeModeState {
  if (typeof window === "undefined") return state;
  if (hydrated) return state;
  hydrated = true;

  const stored = safeRead<Partial<SafeModeState>>(STATE_KEY);
  state = {
    active: stored?.active === true,
    auto: stored?.auto === true,
    reason: stored?.reason,
    since: stored?.since,
    incidents: readIncidents().length,
  };
  if (state.active) {
    addBreadcrumb("safe-mode", "restored", { reason: state.reason ?? "unknown", auto: state.auto });
  }
  emit();
  return state;
}

export function getSafeModeState(): SafeModeState {
  return state;
}

export function isSafeModeActive(): boolean {
  return state.active;
}

export function subscribeSafeMode(listener: (state: SafeModeState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function persist(): void {
  safeWrite(STATE_KEY, {
    active: state.active,
    auto: state.auto,
    reason: state.reason,
    since: state.since,
  });
}

/** Turns Safe Mode on or off. `auto` marks a detector-driven change. */
export function setSafeMode(active: boolean, reason: SafeModeReason = "user", auto = false): SafeModeState {
  if (typeof window === "undefined") return state;
  if (state.active === active) return state;

  state = {
    ...state,
    active,
    auto: active ? auto : false,
    reason: active ? reason : undefined,
    since: active ? Date.now() : undefined,
  };
  if (!active) {
    // A manual re-enable of effects must also clear the history, otherwise a
    // single stale incident re-trips Safe Mode on the next hiccup.
    try {
      window.localStorage.removeItem(LOG_KEY);
    } catch {
      /* ignore */
    }
    state.incidents = 0;
  }
  persist();
  addBreadcrumb("safe-mode", active ? "enabled" : "disabled", { reason, auto });
  emit();
  return state;
}

/**
 * Records a render failure. Returns true when this incident is what engaged
 * Safe Mode, so the caller can tell the user once.
 */
export function recordRenderIncident(kind: IncidentKind): boolean {
  if (typeof window === "undefined") return false;
  initSafeMode();

  const incidents = readIncidents();
  incidents.push({ t: Date.now(), kind });
  const trimmed = incidents.slice(-MAX_INCIDENTS);
  safeWrite(LOG_KEY, trimmed);
  state = { ...state, incidents: trimmed.length };
  addBreadcrumb("safe-mode", `incident:${kind}`, { count: trimmed.length });

  if (state.active || trimmed.length < INCIDENT_THRESHOLD) {
    emit();
    return false;
  }

  setSafeMode(true, kind, true);
  return true;
}

/** Incident history for the diagnostics page. */
export function readSafeModeIncidents(): Incident[] {
  if (typeof window === "undefined") return [];
  return readIncidents();
}

/** Clears the incident history without changing the current mode. */
export function clearSafeModeIncidents(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LOG_KEY);
  } catch {
    /* ignore */
  }
  state = { ...state, incidents: 0 };
  emit();
}
