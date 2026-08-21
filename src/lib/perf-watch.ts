/**
 * Mobile Safari runtime performance watch.
 *
 * iOS Safari almost never tells us it is in trouble: there is no
 * `longtask` PerformanceObserver entry type, no `memory` heap readout, and no
 * warning before the tab is discarded. What it *does* leak is timing — the
 * main thread stops servicing `requestAnimationFrame`, frames get dropped in
 * bursts, and the page is frozen/resumed or restored from bfcache right before
 * a blank screen.
 *
 * This module samples those signals continuously (cheaply), classifies them
 * into a small rolling timeline, and persists it so the events can be lined up
 * against crash reports and Safe Mode incidents on /diagnostics.
 *
 * Hard rules, same as the rest of the diagnostics stack:
 * - never throw (it runs on the code path that is already failing)
 * - never allocate unboundedly
 * - never keep the main thread busy in the name of measuring it
 */

import { addBreadcrumb, deviceContext } from "./client-breadcrumbs";
import { isSafeModeActive, setSafeMode } from "./webkit-safe-mode";

export type PerfEventKind =
  | "long-task"
  | "frame-drop"
  | "memory-pressure"
  | "freeze"
  | "resume"
  | "bfcache-restore"
  | "slow-interaction";

export type PerfSeverity = "info" | "warn" | "severe";

export type PerfEvent = {
  /** Wall-clock ms, so it can be merged with error-log and incident times. */
  at: number;
  kind: PerfEventKind;
  severity: PerfSeverity;
  /** Primary measurement: ms for tasks/interactions, fps for frame drops. */
  value: number;
  /** Route at the time of the sample — jank is usually route-specific. */
  route?: string;
  detail?: string;
};

const KEY = "har_perf_timeline_v1";
const MAX_EVENTS = 60;
/** Below this rAF cadence the UI is visibly stuttering (~<40fps). */
const FRAME_BUDGET_MS = 25;
/** A gap this long means the main thread was blocked, i.e. a long task. */
const LONG_TASK_MS = 120;
/** Sustained stall this long on iOS usually precedes a blank screen. */
const SEVERE_TASK_MS = 800;
/** Frame sampling window. */
const FRAME_WINDOW_MS = 2_000;
/** Heap ratio (Chromium only) that counts as memory pressure. */
const HEAP_WARN_RATIO = 0.7;
const HEAP_SEVERE_RATIO = 0.9;
/** Never emit the same kind more often than this. */
const EMIT_COOLDOWN_MS = 4_000;

let installed = false;
let events: PerfEvent[] = [];
const lastEmit = new Map<PerfEventKind, number>();
const listeners = new Set<(events: PerfEvent[]) => void>();

function route(): string | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.location.pathname;
  } catch {
    return undefined;
  }
}

function load(): PerfEvent[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed.slice(-MAX_EVENTS) as PerfEvent[]) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    /* storage full or Private Browsing — timeline stays in memory */
  }
}

/** Records one performance event (deduped per kind) and notifies listeners. */
export function recordPerfEvent(
  kind: PerfEventKind,
  severity: PerfSeverity,
  value: number,
  detail?: string,
): PerfEvent | undefined {
  try {
    const now = Date.now();
    const last = lastEmit.get(kind);
    // Severe signals always get through; routine noise is throttled.
    if (severity !== "severe" && last && now - last < EMIT_COOLDOWN_MS) return undefined;
    lastEmit.set(kind, now);

    const event: PerfEvent = {
      at: now,
      kind,
      severity,
      value: Math.round(value),
      route: route(),
      ...(detail ? { detail } : {}),
    };
    events.push(event);
    if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
    persist();
    addBreadcrumb("perf", `${kind} ${event.value}${kind === "frame-drop" ? "fps" : "ms"}`, {
      severity,
    });
    listeners.forEach((listener) => {
      try {
        listener(events.slice());
      } catch {
        /* a broken listener must not break instrumentation */
      }
    });
    return event;
  } catch {
    return undefined;
  }
}

export function getPerfEvents(): PerfEvent[] {
  return events.slice();
}

export function clearPerfEvents(): void {
  events = [];
  lastEmit.clear();
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((listener) => listener([]));
}

export function subscribePerfEvents(listener: (events: PerfEvent[]) => void): () => void {
  listeners.add(listener);
  listener(events.slice());
  return () => listeners.delete(listener);
}

export type PerfSummary = {
  events: number;
  severe: number;
  longestTaskMs: number;
  worstFps?: number;
  memoryPressure: boolean;
  lastKind?: PerfEventKind;
  /** ms since the most recent event, for "did jank precede this crash?". */
  sinceLastMs?: number;
};

/** Compact rollup attached to crash reports so jank and crashes correlate. */
export function getPerfSummary(): PerfSummary {
  const longest = events
    .filter((e) => e.kind === "long-task" || e.kind === "slow-interaction")
    .reduce((max, e) => Math.max(max, e.value), 0);
  const frames = events.filter((e) => e.kind === "frame-drop").map((e) => e.value);
  const last = events[events.length - 1];
  return {
    events: events.length,
    severe: events.filter((e) => e.severity === "severe").length,
    longestTaskMs: longest,
    ...(frames.length ? { worstFps: Math.min(...frames) } : {}),
    memoryPressure: events.some((e) => e.kind === "memory-pressure"),
    ...(last ? { lastKind: last.kind, sinceLastMs: Date.now() - last.at } : {}),
  };
}

function severityForTask(ms: number): PerfSeverity {
  if (ms >= SEVERE_TASK_MS) return "severe";
  if (ms >= LONG_TASK_MS * 2) return "warn";
  return "info";
}

type MemoryInfo = { usedJSHeapSize: number; jsHeapSizeLimit: number };

/**
 * Memory pressure, best-effort per engine:
 * - Chromium: real heap ratio from `performance.memory`.
 * - Safari/WebKit: no heap API, so we infer from a low-memory device plus a
 *   severe main-thread stall, which is what heap thrash actually looks like.
 */
function sampleMemory(recentStallMs: number): void {
  const perf = performance as Performance & { memory?: MemoryInfo };
  const mem = perf.memory;
  if (mem && mem.jsHeapSizeLimit > 0) {
    const ratio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
    if (ratio >= HEAP_SEVERE_RATIO) {
      recordPerfEvent("memory-pressure", "severe", Math.round(ratio * 100), "js heap near limit");
    } else if (ratio >= HEAP_WARN_RATIO) {
      recordPerfEvent("memory-pressure", "warn", Math.round(ratio * 100), "js heap elevated");
    }
    return;
  }

  const ctx = deviceContext();
  const lowMemoryDevice = typeof ctx.deviceMemory === "number" && ctx.deviceMemory <= 4;
  if (recentStallMs >= SEVERE_TASK_MS && (lowMemoryDevice || ctx.isIOS === true)) {
    recordPerfEvent(
      "memory-pressure",
      "warn",
      recentStallMs,
      "inferred: sustained stall without heap API (WebKit)",
    );
  }
}

/**
 * Starts the watch. Safe to call repeatedly and on the server (no-op).
 * Returns a teardown for tests.
 */
export function installPerfWatch(): () => void {
  if (typeof window === "undefined" || installed) return () => {};
  installed = true;
  events = load();

  const cleanups: Array<() => void> = [];

  // 1. Long tasks — Chromium reports them natively.
  try {
    const Observer = window.PerformanceObserver as typeof PerformanceObserver | undefined;
    const supported = (Observer as unknown as { supportedEntryTypes?: string[] })?.supportedEntryTypes;
    if (Observer && supported?.includes("longtask")) {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) {
            recordPerfEvent("long-task", severityForTask(entry.duration), entry.duration, "longtask api");
          }
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      cleanups.push(() => observer.disconnect());
    }
    // 2. Slow interactions (tap → paint), the user-visible half of jank.
    if (Observer && supported?.includes("event")) {
      const observer = new Observer((list) => {
        for (const entry of list.getEntries()) {
          const e = entry as PerformanceEntry & { interactionId?: number };
          if (e.duration >= 200 && e.interactionId) {
            recordPerfEvent("slow-interaction", e.duration >= 500 ? "warn" : "info", e.duration, e.name);
          }
        }
      });
      observer.observe({ type: "event", buffered: true, durationThreshold: 200 } as PerformanceObserverInit);
      cleanups.push(() => observer.disconnect());
    }
  } catch {
    /* observers are optional */
  }

  // 3. rAF cadence — the only long-task/frame signal WebKit gives us. Runs one
  //    cheap comparison per frame and only reports per window. Torn down while
  //    the tab is hidden so instrumentation cannot keep a backgrounded iPhone hot.
  let raf = 0;
  let sampling = false;
  let last = performance.now();
  let windowStart = last;
  let frames = 0;
  let dropped = 0;
  let worstGap = 0;
  let jankSafeModeArmed = true;

  const maybeEngageSafeModeFromJank = (fps: number) => {
    if (!jankSafeModeArmed || fps >= 20) return;
    if (isSafeModeActive()) return;
    const ctx = deviceContext();
    if (ctx.isIOS !== true) return;
    jankSafeModeArmed = false;
    setSafeMode(true, "jank", true);
  };

  const tick = () => {
    if (!sampling) return;
    const now = performance.now();
    const gap = now - last;
    last = now;
    frames += 1;
    if (gap > FRAME_BUDGET_MS) dropped += 1;
    if (gap > worstGap) worstGap = gap;

    // A single huge gap is a blocked main thread: report immediately.
    if (gap >= LONG_TASK_MS && document.visibilityState === "visible") {
      recordPerfEvent("long-task", severityForTask(gap), gap, "raf stall");
      sampleMemory(gap);
    }

    if (now - windowStart >= FRAME_WINDOW_MS) {
      const fps = (frames / (now - windowStart)) * 1000;
      if (document.visibilityState === "visible" && frames > 5 && dropped / frames > 0.3) {
        recordPerfEvent(
          "frame-drop",
          fps < 20 ? "severe" : "warn",
          fps,
          `${dropped}/${frames} frames over budget`,
        );
        maybeEngageSafeModeFromJank(fps);
      }
      windowStart = now;
      frames = 0;
      dropped = 0;
      worstGap = 0;
    }
    raf = requestAnimationFrame(tick);
  };

  const startSampling = () => {
    if (sampling) return;
    sampling = true;
    last = performance.now();
    windowStart = last;
    frames = 0;
    dropped = 0;
    worstGap = 0;
    raf = requestAnimationFrame(tick);
  };

  const stopSampling = () => {
    sampling = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };

  const onVisibilityForRaf = () => {
    if (document.visibilityState === "hidden") stopSampling();
    else startSampling();
  };

  startSampling();
  document.addEventListener("visibilitychange", onVisibilityForRaf);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", onVisibilityForRaf);
    stopSampling();
  });

  // 4. Periodic memory sampling (cheap; also covers idle pages).
  const heapTimer = window.setInterval(() => sampleMemory(0), 15_000);
  cleanups.push(() => window.clearInterval(heapTimer));

  // 5. Lifecycle pressure signals. On iOS these are the last thing recorded
  //    before the tab is discarded, so they anchor the crash timeline.
  const onFreeze = () => recordPerfEvent("freeze", "warn", 0, "page frozen by the browser");
  const onResume = () => {
    recordPerfEvent("resume", "info", 0, "page resumed");
    last = performance.now();
    windowStart = last;
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) recordPerfEvent("bfcache-restore", "info", 0, "restored from bfcache");
  };
  document.addEventListener("freeze", onFreeze);
  document.addEventListener("resume", onResume);
  window.addEventListener("pageshow", onPageShow);
  cleanups.push(() => {
    document.removeEventListener("freeze", onFreeze);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pageshow", onPageShow);
  });

  return () => {
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
    installed = false;
  };
}
