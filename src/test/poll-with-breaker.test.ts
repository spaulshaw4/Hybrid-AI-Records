import { describe, expect, it, vi } from "vitest";
import {
  isTerminalHttpStatus,
  isTerminalPollStatus,
  pollWithBreaker,
} from "@/lib/poll-with-breaker.server";

describe("pollWithBreaker", () => {
  it("returns when validate passes before max attempts", async () => {
    let n = 0;
    const result = await pollWithBreaker(
      async () => {
        n += 1;
        return n;
      },
      (value) => value >= 3,
      () => false,
      { maxAttempts: 30, intervalMs: 1, stepName: "Gate 4 Demucs" },
    );
    expect(result).toBe(3);
    expect(n).toBe(3);
  });

  it("aborts on terminal error results", async () => {
    await expect(
      pollWithBreaker(
        async () => ({ status: "failed" }),
        (r) => r.status === "succeeded",
        (r) => isTerminalPollStatus(r.status),
        { maxAttempts: 30, intervalMs: 1, stepName: "Gate 1 AIMusicAPI" },
      ),
    ).rejects.toThrow(/terminal error/i);
  });

  it("trips after maxAttempts and logs each attempt", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      pollWithBreaker(
        async () => "pending",
        () => false,
        () => false,
        { maxAttempts: 3, intervalMs: 1, stepName: "Gate 4 Demucs" },
      ),
    ).rejects.toThrow(/Exceeded max attempts \(3\)/);
    expect(log).toHaveBeenCalledWith("[Polling Gate 4 Demucs] Attempt 1/3...");
    expect(log).toHaveBeenCalledWith("[Polling Gate 4 Demucs] Attempt 2/3...");
    expect(log).toHaveBeenCalledWith("[Polling Gate 4 Demucs] Attempt 3/3...");
    log.mockRestore();
  });

  it("classifies failed/canceled statuses and 4xx/5xx HTTP codes", () => {
    expect(isTerminalPollStatus("failed")).toBe(true);
    expect(isTerminalPollStatus("canceled")).toBe(true);
    expect(isTerminalPollStatus("processing")).toBe(false);
    expect(isTerminalHttpStatus(404)).toBe(true);
    expect(isTerminalHttpStatus(503)).toBe(true);
    expect(isTerminalHttpStatus(200)).toBe(false);
  });
});
