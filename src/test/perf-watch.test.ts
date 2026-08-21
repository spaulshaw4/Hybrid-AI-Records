import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPerfEvents,
  getPerfEvents,
  getPerfSummary,
  recordPerfEvent,
  subscribePerfEvents,
} from "@/lib/perf-watch";

describe("perf-watch timeline", () => {
  beforeEach(() => {
    clearPerfEvents();
  });

  it("records events with wall-clock timestamps and rounded values", () => {
    recordPerfEvent("long-task", "warn", 312.7, "raf stall");
    const [event] = getPerfEvents();
    expect(event.kind).toBe("long-task");
    expect(event.value).toBe(313);
    expect(event.at).toBeGreaterThan(0);
    expect(event.detail).toBe("raf stall");
  });

  it("throttles repeated non-severe events but never drops severe ones", () => {
    recordPerfEvent("frame-drop", "warn", 18);
    recordPerfEvent("frame-drop", "warn", 17);
    expect(getPerfEvents().filter((e) => e.kind === "frame-drop")).toHaveLength(1);

    recordPerfEvent("frame-drop", "severe", 9);
    expect(getPerfEvents().filter((e) => e.kind === "frame-drop")).toHaveLength(2);
  });

  it("summarises stalls, frame rate and memory pressure for crash correlation", () => {
    recordPerfEvent("long-task", "severe", 900);
    recordPerfEvent("frame-drop", "severe", 12);
    recordPerfEvent("memory-pressure", "warn", 82, "js heap elevated");

    const summary = getPerfSummary();
    expect(summary.events).toBe(3);
    expect(summary.severe).toBe(2);
    expect(summary.longestTaskMs).toBe(900);
    expect(summary.worstFps).toBe(12);
    expect(summary.memoryPressure).toBe(true);
    expect(summary.lastKind).toBe("memory-pressure");
    expect(summary.sinceLastMs).toBeGreaterThanOrEqual(0);
  });

  it("notifies subscribers and clears cleanly", () => {
    const seen: number[] = [];
    const unsubscribe = subscribePerfEvents((events) => seen.push(events.length));
    recordPerfEvent("freeze", "warn", 0);
    expect(seen.at(-1)).toBe(1);
    clearPerfEvents();
    expect(getPerfEvents()).toEqual([]);
    unsubscribe();
  });
});
