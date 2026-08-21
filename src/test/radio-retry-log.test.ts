import { describe, expect, it, beforeEach } from "vitest";
import {
  RETRY_LOG_KEY,
  RETRY_LOG_LIMIT,
  classifyRetryError,
  failRetryAttempt,
  finishRetryAttempt,
  readRetryLog,
  settleAttempt,
  startRetryAttempt,
  withAttempt,
  type RetryAttempt,
} from "@/lib/radio-retry-log";

const attempt = (over: Partial<RetryAttempt> = {}): RetryAttempt => ({
  id: "a1",
  at: 1_000,
  device: "Chrome on macOS",
  outcome: "pending",
  ...over,
});

describe("retry attempt log", () => {
  beforeEach(() => window.localStorage.clear());

  it("records the device, account and timestamp when a retry starts", () => {
    const id = startRetryAttempt("Safari on iOS", "artist@example.com");
    const [entry] = readRetryLog();
    expect(entry?.id).toBe(id);
    expect(entry?.device).toBe("Safari on iOS");
    expect(entry?.account).toBe("artist@example.com");
    expect(entry?.outcome).toBe("pending");
    expect(entry?.at).toBeGreaterThan(0);
  });

  it("closes an attempt with the successful reconciliation and duration", () => {
    const id = startRetryAttempt("Chrome on macOS");
    finishRetryAttempt(id, 2, "Safari on iOS");
    const [entry] = readRetryLog();
    expect(entry?.outcome).toBe("success");
    expect(entry?.tracks).toBe(2);
    expect(entry?.wonBy).toBe("Safari on iOS");
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry?.settledAt).toBeGreaterThanOrEqual(entry!.at);
  });

  it("closes an attempt with the specific error it returned", () => {
    const id = startRetryAttempt("Chrome on macOS");
    failRetryAttempt(id, "Couldn't reach your account to resolve playback timestamps.");
    const [entry] = readRetryLog();
    expect(entry?.outcome).toBe("error");
    expect(entry?.errorKind).toBe("network");
    expect(entry?.error).toContain("reach your account");
  });

  it("never rewrites an attempt that already settled", () => {
    const log = [attempt()];
    const once = settleAttempt(log, "a1", { outcome: "success", tracks: 1, settledAt: 1_500 });
    const twice = settleAttempt(once, "a1", { outcome: "error", error: "late failure", settledAt: 9_000 });
    expect(twice[0]?.outcome).toBe("success");
    expect(twice[0]?.durationMs).toBe(500);
  });

  it("keeps attempts newest-first and bounded", () => {
    let log: RetryAttempt[] = [];
    for (let i = 0; i < RETRY_LOG_LIMIT + 5; i++) {
      log = withAttempt(log, attempt({ id: `a${i}`, at: 1_000 + i }));
    }
    expect(log).toHaveLength(RETRY_LOG_LIMIT);
    expect(log[0]?.id).toBe(`a${RETRY_LOG_LIMIT + 4}`);
  });

  it("survives a reload and tolerates corrupt storage", () => {
    const id = startRetryAttempt("Firefox on Linux");
    expect(readRetryLog().find((a) => a.id === id)).toBeTruthy();
    window.localStorage.setItem(RETRY_LOG_KEY, "{not json");
    expect(readRetryLog()).toEqual([]);
  });

  it("classifies the errors the sync path can produce", () => {
    expect(classifyRetryError("This device is offline.")).toBe("offline");
    expect(classifyRetryError("Not signed in — no account to sync with.")).toBe("no-account");
    expect(classifyRetryError("Unauthorized")).toBe("auth");
    expect(classifyRetryError("Couldn't compare playback timestamps from your other devices.")).toBe("merge");
    expect(classifyRetryError("Failed to fetch")).toBe("network");
    expect(classifyRetryError("boom")).toBe("unknown");
  });
});
