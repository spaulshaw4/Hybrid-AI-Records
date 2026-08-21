/**
 * Client-side render performance instrumentation.
 *
 * Four signals matter when the studio viewport misbehaves:
 *  - re-render counts per component (is a state update feeding itself?)
 *  - FPS impact (is the main thread actually stuttering while we render?)
 *  - reconnect attempts (is the resilient-fetch layer thrashing upstream?)
 *  - time-to-first-frame (how long until the user sees any picture?)
 *
 * They are collected in one tiny in-memory store with a pub/sub so the debug
 * overlay can subscribe without polling, plus a rolling log line feed. The
 * store must never throw and never grow unbounded — it runs on the same code
 * path that is already under stress.
 */

export type TelemetryLog = {
  at: number;
  label: string;
  message: string;
};

/** Baseline operational cost per rendered shot, in USD. */
export const COST_PER_SHOT_USD = 0.062;

export type BlockTelemetry = {
  index: number;
  startedAt: number;
  /** Wall time of the block once it settled, in ms. */
  durationMs: number | null;
  state: "active" | "done" | "failed";
};

export type RenderTelemetry = {
  /** Re-render counts keyed by component label. */
  renders: Record<string, number>;
  /** Renders counted in the last rolling second, keyed by component label. */
  rendersPerSecond: Record<string, number>;
  /** Current sampled frame rate (rAF based), or null before the first sample. */
  fps: number | null;
  /** Lowest fps seen since the last reset. */
  minFps: number | null;
  /** Reconnect / retry attempts keyed by upstream label. */
  reconnects: Record<string, number>;
  /** ms between render start and the first visible frame. */
  timeToFirstFrameMs: number | null;
  /** Wall clock of the current run's start, if one is in flight. */
  runStartedAt: number | null;
  /** Per-block execution timing, keyed by 1-based block index. */
  blocks: Record<number, BlockTelemetry>;
  /** Total backoff/wait time spent inside resilientFetch retries, in ms. */
  backoffMs: number;
  /** Rolling network latencies (ms) for upstream dispatch/poll calls. */
  latenciesMs: number[];
  /** Rolling diagnostic lines. */
  logs: TelemetryLog[];
};

const MAX_LOGS = 40;

let state: RenderTelemetry = {
  renders: {},
  rendersPerSecond: {},
  fps: null,
  minFps: null,
  reconnects: {},
  timeToFirstFrameMs: null,
  runStartedAt: null,
  blocks: {},
  backoffMs: 0,
  latenciesMs: [],
  logs: [],
};

const listeners = new Set<(next: RenderTelemetry) => void>();
let flushQueued = false;

/**
 * Notifications are coalesced into a microtask-batched animation frame so the
 * overlay repaints at most once per frame — instrumentation must not become
 * the source of the re-render storm it is measuring.
 */
function publish() {
  if (flushQueued) return;
  flushQueued = true;
  const run = () => {
    flushQueued = false;
    const snapshot = state;
    listeners.forEach((listener) => {
      try {
        listener(snapshot);
      } catch {
        /* a broken subscriber must never break the pipeline */
      }
    });
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function patch(next: Partial<RenderTelemetry>) {
  state = { ...state, ...next };
  publish();
}

export function getRenderTelemetry(): RenderTelemetry {
  return state;
}

export function subscribeRenderTelemetry(
  listener: (next: RenderTelemetry) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function logTelemetry(label: string, message: string) {
  state = {
    ...state,
    logs: [{ at: Date.now(), label, message }, ...state.logs].slice(0, MAX_LOGS),
  };
  publish();
}

/** Called from the loop guard on every commit of an instrumented component. */
export function recordRender(label: string, perSecond: number) {
  state = {
    ...state,
    renders: { ...state.renders, [label]: (state.renders[label] ?? 0) + 1 },
    rendersPerSecond: { ...state.rendersPerSecond, [label]: perSecond },
  };
  publish();
}

/** Called whenever the client retries or reconnects to an upstream service. */
export function recordReconnect(label: string, detail?: string) {
  const count = (state.reconnects[label] ?? 0) + 1;
  state = { ...state, reconnects: { ...state.reconnects, [label]: count } };
  logTelemetry(label, `Reconnect attempt #${count}${detail ? ` — ${detail}` : ""}`);
}

/** Marks the beginning of a render run (resets time-to-first-frame). */
export function markRunStart() {
  patch({ runStartedAt: Date.now(), timeToFirstFrameMs: null });
  logTelemetry("render", "Run started — measuring time-to-first-frame.");
}

/** Marks the moment the first playable frame/clip exists. Idempotent. */
export function markFirstFrame() {
  if (state.timeToFirstFrameMs !== null || state.runStartedAt === null) return;
  const ms = Date.now() - state.runStartedAt;
  patch({ timeToFirstFrameMs: ms });
  logTelemetry("render", `First frame ready in ${(ms / 1000).toFixed(1)}s.`);
}

/** Marks a scene block as started — resets any previous timing for it. */
export function recordBlockStart(index: number) {
  patch({
    blocks: {
      ...state.blocks,
      [index]: { index, startedAt: Date.now(), durationMs: null, state: "active" },
    },
  });
}

/** Settles a block: stores its wall time and outcome, and logs the cost line. */
export function recordBlockEnd(index: number, outcome: "done" | "failed") {
  const existing = state.blocks[index];
  const durationMs = existing ? Date.now() - existing.startedAt : null;
  patch({
    blocks: {
      ...state.blocks,
      [index]: {
        index,
        startedAt: existing?.startedAt ?? Date.now(),
        durationMs,
        state: outcome,
      },
    },
  });
  logTelemetry(
    "block",
    `Block ${index} ${outcome}${durationMs === null ? "" : ` in ${(durationMs / 1000).toFixed(1)}s`}` +
      (outcome === "done" ? ` — $${COST_PER_SHOT_USD.toFixed(3)}` : ""),
  );
}

/** Time spent waiting between resilientFetch attempts. */
export function recordBackoff(label: string, delayMs: number) {
  patch({ backoffMs: state.backoffMs + Math.max(0, delayMs) });
  logTelemetry(label, `Backoff ${Math.round(delayMs)}ms before the next attempt.`);
}

/** Round-trip latency of a single upstream call. */
export function recordLatency(ms: number) {
  patch({ latenciesMs: [...state.latenciesMs, Math.max(0, ms)].slice(-60) });
}

/** Derived performance / cost matrix used by the debug overlay. */
export function performanceMatrix(snapshot: RenderTelemetry = state) {
  const blocks = Object.values(snapshot.blocks);
  const settled = blocks.filter((b) => b.durationMs !== null);
  const done = blocks.filter((b) => b.state === "done").length;
  const failed = blocks.filter((b) => b.state === "failed").length;
  const avgBlockMs = settled.length
    ? Math.round(settled.reduce((sum, b) => sum + (b.durationMs ?? 0), 0) / settled.length)
    : null;
  const avgLatencyMs = snapshot.latenciesMs.length
    ? Math.round(
        snapshot.latenciesMs.reduce((sum, ms) => sum + ms, 0) / snapshot.latenciesMs.length,
      )
    : null;
  // Failed shots still burn upstream compute, so they are billed in the estimate.
  const spendUsd = Number(((done + failed) * COST_PER_SHOT_USD).toFixed(3));
  return { total: blocks.length, done, failed, avgBlockMs, avgLatencyMs, spendUsd };
}

export function resetRenderTelemetry() {
  state = {
    renders: {},
    rendersPerSecond: {},
    fps: null,
    minFps: null,
    reconnects: {},
    timeToFirstFrameMs: null,
    runStartedAt: null,
    blocks: {},
    backoffMs: 0,
    latenciesMs: [],
    logs: [],
  };
  publish();
}

let fpsStop: (() => void) | null = null;
let fpsRefs = 0;

/**
 * Starts (or joins) the shared rAF frame-rate sampler. Reference counted so
 * several overlays can mount without stacking loops. Sampling is one
 * `performance.now()` read per frame and one state write per second.
 */
export function startFpsSampling(): () => void {
  fpsRefs += 1;
  if (!fpsStop) {
    if (typeof requestAnimationFrame !== "function") {
      fpsStop = () => {};
    } else {
      let frames = 0;
      let windowStart = performance.now();
      let raf = 0;
      const tick = () => {
        if (document.visibilityState === "hidden") {
          raf = requestAnimationFrame(tick);
          return;
        }
        frames += 1;
        const now = performance.now();
        if (now - windowStart >= 1000) {
          const fps = Math.round((frames * 1000) / (now - windowStart));
          const minFps = state.minFps === null ? fps : Math.min(state.minFps, fps);
          patch({ fps, minFps });
          if (fps < 30) logTelemetry("fps", `Frame rate dropped to ${fps} fps.`);
          frames = 0;
          windowStart = now;
        }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      fpsStop = () => cancelAnimationFrame(raf);
    }
  }
  return () => {
    fpsRefs -= 1;
    if (fpsRefs <= 0) {
      fpsStop?.();
      fpsStop = null;
      fpsRefs = 0;
    }
  };
}
