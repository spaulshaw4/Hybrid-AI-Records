/**
 * Dedicated render-state machine.
 *
 * The cinematic render used to be steered by loose booleans (`isGenerating`,
 * `canRetry`) plus a free-form `stage` string. Any late callback — a resilient
 * fetch retry landing after a failure, a poll finishing after the user reset —
 * could flip those booleans back on and put the viewport into a
 * render → fail → render loop.
 *
 * This reducer makes the legal transitions explicit. Anything illegal is a
 * no-op that returns the *same object reference*, so React bails out of the
 * re-render entirely: an infinite loop is structurally impossible.
 */

export type RenderStatus =
  | "idle"
  | "connecting"
  | "rendering"
  | "retrying"
  | "failed"
  | "completed";

export interface RenderState {
  status: RenderStatus;
  /** Human-readable note for the current step (shown on the render button). */
  note: string | null;
  /** Last failure message, kept while `status === "failed"`. */
  error: string | null;
  /** How many retry passes have been started for this run. */
  attempt: number;
}

export type RenderEvent =
  | { type: "START"; note?: string }
  | { type: "CONNECTED"; note?: string }
  | { type: "PROGRESS"; note: string }
  | { type: "RETRY"; note?: string }
  | { type: "FAIL"; error: string }
  | { type: "COMPLETE" }
  /** Terminal settle used by `finally` blocks — never resurrects a failure. */
  | { type: "SETTLE" }
  | { type: "RESET" };

export const INITIAL_RENDER_STATE: RenderState = {
  status: "idle",
  note: null,
  error: null,
  attempt: 0,
};

/** Transitions that each status is allowed to take. Everything else is ignored. */
const ALLOWED: Record<RenderStatus, ReadonlyArray<RenderEvent["type"]>> = {
  idle: ["START", "RESET"],
  connecting: ["CONNECTED", "PROGRESS", "FAIL", "COMPLETE", "SETTLE", "RESET"],
  rendering: ["PROGRESS", "FAIL", "COMPLETE", "SETTLE", "RESET"],
  retrying: ["CONNECTED", "PROGRESS", "FAIL", "COMPLETE", "SETTLE", "RESET"],
  failed: ["RETRY", "START", "RESET"],
  completed: ["START", "RETRY", "RESET"],
};

export function canTransition(status: RenderStatus, event: RenderEvent["type"]) {
  return ALLOWED[status].includes(event);
}

export function renderReducer(state: RenderState, event: RenderEvent): RenderState {
  if (!canTransition(state.status, event.type)) return state;

  switch (event.type) {
    case "START":
      return {
        status: "connecting",
        note: event.note ?? "Connecting to the render pipeline…",
        error: null,
        attempt: 0,
      };
    case "CONNECTED":
      return {
        ...state,
        status: "rendering",
        note: event.note ?? state.note,
        error: null,
      };
    case "PROGRESS": {
      // Same note while already rendering → identical state, no repaint.
      if (state.status === "rendering" && state.note === event.note) return state;
      return { ...state, status: "rendering", note: event.note, error: null };
    }
    case "RETRY":
      return {
        status: "retrying",
        note: event.note ?? "Retrying unfinished scene blocks…",
        error: null,
        attempt: state.attempt + 1,
      };
    case "FAIL":
      if (state.status === "failed" && state.error === event.error) return state;
      return { ...state, status: "failed", note: null, error: event.error };
    case "COMPLETE":
      return { ...state, status: "completed", note: null, error: null };
    case "SETTLE":
      // Called from `finally`: only closes out a run that is still in flight.
      return { ...state, status: "completed", note: null };
    case "RESET":
      return state.status === "idle" ? state : INITIAL_RENDER_STATE;
    default:
      return state;
  }
}

/** True while the pipeline owns the UI (buttons disabled, viewport locked). */
export function isRenderBusy(status: RenderStatus) {
  return status === "connecting" || status === "rendering" || status === "retrying";
}
