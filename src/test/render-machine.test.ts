/**
 * Unit coverage for the render state machine.
 *
 * The contract that keeps the studio out of infinite loops is: every illegal
 * transition is a no-op that returns the *same object reference*, so React
 * bails out instead of re-rendering.
 */
import { describe, expect, it } from "vitest";

import {
  INITIAL_RENDER_STATE,
  canTransition,
  isRenderBusy,
  renderReducer,
  type RenderState,
} from "@/lib/render-machine";

function run(events: Parameters<typeof renderReducer>[1][], from = INITIAL_RENDER_STATE) {
  return events.reduce<RenderState>((state, event) => renderReducer(state, event), from);
}

describe("render machine — happy path", () => {
  it("walks idle → connecting → rendering → completed", () => {
    const connecting = renderReducer(INITIAL_RENDER_STATE, { type: "START" });
    expect(connecting.status).toBe("connecting");

    const rendering = renderReducer(connecting, { type: "CONNECTED" });
    expect(rendering.status).toBe("rendering");

    const progressed = renderReducer(rendering, { type: "PROGRESS", note: "Block 2 of 8" });
    expect(progressed.note).toBe("Block 2 of 8");

    const completed = renderReducer(progressed, { type: "COMPLETE" });
    expect(completed.status).toBe("completed");
    expect(completed.error).toBeNull();
  });

  it("marks the pipeline busy only while a run owns the UI", () => {
    expect(isRenderBusy("connecting")).toBe(true);
    expect(isRenderBusy("rendering")).toBe(true);
    expect(isRenderBusy("retrying")).toBe(true);
    expect(isRenderBusy("failed")).toBe(false);
    expect(isRenderBusy("completed")).toBe(false);
    expect(isRenderBusy("idle")).toBe(false);
  });
});

describe("render machine — error and retry", () => {
  it("fails, retries with an incremented attempt, then completes", () => {
    const failed = run([{ type: "START" }, { type: "CONNECTED" }, { type: "FAIL", error: "Block 3 timed out." }]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Block 3 timed out.");

    const retrying = renderReducer(failed, { type: "RETRY" });
    expect(retrying.status).toBe("retrying");
    expect(retrying.attempt).toBe(1);
    expect(retrying.error).toBeNull();

    const done = run([{ type: "PROGRESS", note: "Resuming block 3" }, { type: "COMPLETE" }], retrying);
    expect(done.status).toBe("completed");
  });

  it("never resurrects a failed run from a late callback", () => {
    const failed = run([{ type: "START" }, { type: "FAIL", error: "Upstream unreachable" }]);

    // These all arrive after the failure — every one must be ignored.
    for (const event of [
      { type: "PROGRESS", note: "Block 4 of 8" },
      { type: "CONNECTED" },
      { type: "COMPLETE" },
      { type: "SETTLE" },
    ] as const) {
      expect(renderReducer(failed, event)).toBe(failed);
    }
  });

  it("returns identical references for no-op transitions (no re-render)", () => {
    expect(renderReducer(INITIAL_RENDER_STATE, { type: "PROGRESS", note: "x" })).toBe(
      INITIAL_RENDER_STATE,
    );
    expect(renderReducer(INITIAL_RENDER_STATE, { type: "RESET" })).toBe(INITIAL_RENDER_STATE);

    const rendering = run([{ type: "START" }, { type: "PROGRESS", note: "same" }]);
    expect(renderReducer(rendering, { type: "PROGRESS", note: "same" })).toBe(rendering);

    const failed = renderReducer(rendering, { type: "FAIL", error: "boom" });
    expect(renderReducer(failed, { type: "FAIL", error: "boom" })).toBe(failed);
  });

  it("keeps the allow-list and the reducer in agreement", () => {
    expect(canTransition("idle", "PROGRESS")).toBe(false);
    expect(canTransition("failed", "RETRY")).toBe(true);
    expect(canTransition("completed", "PROGRESS")).toBe(false);
    expect(canTransition("rendering", "SETTLE")).toBe(true);
  });

  it("RESET returns to a pristine idle state from anywhere", () => {
    const messy = run([
      { type: "START" },
      { type: "CONNECTED" },
      { type: "FAIL", error: "nope" },
      { type: "RETRY" },
      { type: "RESET" },
    ]);
    expect(messy).toEqual(INITIAL_RENDER_STATE);
  });
});
