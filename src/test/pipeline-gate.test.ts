import { describe, expect, it, vi } from "vitest";
import {
  GATE_1_MUSIC_TIMEOUT_MS,
  GATE_TIMEOUTS_MS,
  gateTimeoutMs,
  withGateTimeout,
  withTimeout,
} from "@/lib/pipeline-gate.server";

describe("pipeline gate timeouts", () => {
  it("budgets each gate per the circuit breaker table", () => {
    expect(gateTimeoutMs(1)).toBe(GATE_1_MUSIC_TIMEOUT_MS);
    expect(gateTimeoutMs(1)).toBe(200_000);
    expect(gateTimeoutMs(2)).toBe(30_000);
    expect(gateTimeoutMs(3)).toBe(60_000);
    expect(gateTimeoutMs(4)).toBe(90_000);
    expect(gateTimeoutMs(5)).toBe(60_000);
    expect(gateTimeoutMs(6)).toBe(60_000);
    expect(GATE_TIMEOUTS_MS[2]).toBe(30_000);
  });

  it("rejects when work exceeds the gate deadline", async () => {
    vi.useFakeTimers();
    const pending = withTimeout(
      new Promise(() => undefined),
      50,
      "Gate 2 (Supabase Upload)",
    );
    const assertion = expect(pending).rejects.toThrow(/Circuit Breaker.*timed out/i);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });

  it("resolves when work finishes before the deadline", async () => {
    await expect(withGateTimeout(3, Promise.resolve("ok"), 1_000)).resolves.toBe("ok");
  });
});
