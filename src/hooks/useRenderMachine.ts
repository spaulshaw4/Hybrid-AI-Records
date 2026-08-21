import { useCallback, useMemo, useReducer, useRef } from "react";
import { recordClientError } from "@/lib/client-error-log";
import {
  INITIAL_RENDER_STATE,
  isRenderBusy,
  renderReducer,
  type RenderState,
  type RenderStatus,
} from "@/lib/render-machine";

/**
 * React binding for the render-state machine.
 *
 * Every action is a stable `useCallback`, and the reducer returns the same
 * object for illegal or no-op transitions, so memoised children (the progress
 * panel, the master player) never re-mount because of background pipeline
 * chatter. A `statusRef` is exposed for background loops that need to read the
 * current phase without subscribing to it.
 */
/** Max state transitions accepted per second before the guard trips. */
const MAX_TRANSITIONS_PER_SECOND = 40;

export function useRenderMachine() {
  const [state, rawDispatch] = useReducer(renderReducer, INITIAL_RENDER_STATE);
  const window0 = useRef({ start: 0, count: 0, tripped: false });

  /**
   * Rate-capped dispatch: a runaway caller (a poll loop that keeps firing after
   * a failure, a retry cascade that re-enters itself) is dropped rather than
   * repainting the studio forever. The first drop logs one clear diagnostic.
   */
  const dispatch = useCallback((event: Parameters<typeof rawDispatch>[0]) => {
    const now = Date.now();
    const w = window0.current;
    if (now - w.start > 1000) {
      w.start = now;
      w.count = 0;
      w.tripped = false;
    }
    w.count += 1;
    if (w.count > MAX_TRANSITIONS_PER_SECOND) {
      if (!w.tripped) {
        w.tripped = true;
        const message = `Render state machine loop capped: ${w.count} transitions in <1s (cap ${MAX_TRANSITIONS_PER_SECOND}). Last event: ${event.type}.`;
        console.error(`[loop-guard] ${message}`, event);
        recordClientError({
          severity: "non-fatal",
          source: "render-machine",
          name: "RenderTransitionFlood",
          message,
          extra: { event: event.type, count: w.count },
        });
      }
      return;
    }
    rawDispatch(event);
  }, []);
  const statusRef = useRef<RenderStatus>(state.status);
  statusRef.current = state.status;

  const start = useCallback((note?: string) => {
    dispatch(note ? { type: "START", note } : { type: "START" });
  }, []);
  const connected = useCallback((note?: string) => {
    dispatch(note ? { type: "CONNECTED", note } : { type: "CONNECTED" });
  }, []);
  const progress = useCallback((note: string) => {
    dispatch({ type: "PROGRESS", note });
  }, []);
  const retry = useCallback((note?: string) => {
    dispatch(note ? { type: "RETRY", note } : { type: "RETRY" });
  }, []);
  const fail = useCallback((error: string) => {
    dispatch({ type: "FAIL", error });
  }, []);
  const complete = useCallback(() => dispatch({ type: "COMPLETE" }), []);
  const settle = useCallback(() => dispatch({ type: "SETTLE" }), []);
  const reset = useCallback(() => dispatch({ type: "RESET" }), []);

  const actions = useMemo(
    () => ({ start, connected, progress, retry, fail, complete, settle, reset }),
    [start, connected, progress, retry, fail, complete, settle, reset],
  );

  return useMemo(
    () => ({
      ...(state as RenderState),
      busy: isRenderBusy(state.status),
      canRetry: state.status === "failed",
      statusRef,
      ...actions,
    }),
    [state, actions],
  );
}
