/**
 * Telemetry & performance-matrix coverage: block timing, backoff accumulation,
 * upstream latency and the ~$0.062-per-shot cost baseline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COST_PER_SHOT_USD,
  getRenderTelemetry,
  markFirstFrame,
  markRunStart,
  performanceMatrix,
  recordBackoff,
  recordBlockEnd,
  recordBlockStart,
  recordLatency,
  recordReconnect,
  resetRenderTelemetry,
} from "@/lib/render-telemetry";

describe("render telemetry matrix", () => {
  beforeEach(() => {
    resetRenderTelemetry();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetRenderTelemetry();
  });

  it("times each block and bills every attempted shot at the baseline rate", () => {
    expect(COST_PER_SHOT_USD).toBeCloseTo(0.062, 5);

    recordBlockStart(1);
    vi.advanceTimersByTime(20_000);
    recordBlockEnd(1, "done");

    recordBlockStart(2);
    vi.advanceTimersByTime(10_000);
    recordBlockEnd(2, "failed");

    const matrix = performanceMatrix();
    expect(matrix.total).toBe(2);
    expect(matrix.done).toBe(1);
    expect(matrix.failed).toBe(1);
    expect(matrix.avgBlockMs).toBe(15_000);
    expect(matrix.spendUsd).toBeCloseTo(0.124, 5);
  });

  it("accumulates retry backoff and averages upstream latency", () => {
    recordBackoff("render-poll", 6000);
    recordBackoff("render-poll", 7200);
    recordLatency(100);
    recordLatency(300);

    expect(getRenderTelemetry().backoffMs).toBe(13_200);
    expect(performanceMatrix().avgLatencyMs).toBe(200);
  });

  it("tracks reconnects and time-to-first-frame across a run", () => {
    markRunStart();
    recordReconnect("render-dispatch", "block 1: 503");
    vi.advanceTimersByTime(4200);
    markFirstFrame();
    // Idempotent: a second call must not overwrite the measurement.
    vi.advanceTimersByTime(5000);
    markFirstFrame();

    const snapshot = getRenderTelemetry();
    expect(snapshot.reconnects["render-dispatch"]).toBe(1);
    expect(snapshot.timeToFirstFrameMs).toBe(4200);
    expect(snapshot.logs.some((l) => l.label === "render-dispatch")).toBe(true);
  });

  it("resets cleanly between runs", () => {
    recordBlockStart(1);
    recordBlockEnd(1, "done");
    recordBackoff("render-poll", 1000);
    resetRenderTelemetry();

    const matrix = performanceMatrix();
    expect(matrix.total).toBe(0);
    expect(matrix.spendUsd).toBe(0);
    expect(getRenderTelemetry().backoffMs).toBe(0);
    expect(getRenderTelemetry().logs).toHaveLength(0);
  });
});
