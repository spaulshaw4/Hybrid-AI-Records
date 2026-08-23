import { describe, expect, it, beforeEach } from "vitest";
import {
  __resetPipelineWorkerForTests,
  isFatalPipelineError,
  isTransientNetworkError,
  shouldAutoRetryJob,
  MAX_TRANSIENT_RETRIES,
  WorkerWatchdogError,
  WorkerSlotBusyError,
} from "@/lib/pipeline-worker.server";

describe("pipeline-worker retry policy", () => {
  beforeEach(() => {
    __resetPipelineWorkerForTests();
  });

  it("retries transient network drops within the attempt budget", () => {
    const err = new Error("fetch failed: ECONNRESET");
    expect(isTransientNetworkError(err)).toBe(true);
    expect(isFatalPipelineError(err)).toBe(false);
    expect(shouldAutoRetryJob(err, 1, MAX_TRANSIENT_RETRIES + 1)).toBe(true);
    expect(shouldAutoRetryJob(err, MAX_TRANSIENT_RETRIES + 1, MAX_TRANSIENT_RETRIES + 1)).toBe(
      false,
    );
  });

  it("does not retry fatal model / auth errors", () => {
    const auth = new Error("Invalid API key rejected by MusicAPI");
    expect(isFatalPipelineError(auth)).toBe(true);
    expect(shouldAutoRetryJob(auth, 1, 5)).toBe(false);

    const payload = new Error("Music engine: 422 out of range");
    expect(isFatalPipelineError(payload)).toBe(true);
    expect(shouldAutoRetryJob(payload, 1, 5)).toBe(false);
  });

  it("does not retry watchdog or slot-busy errors", () => {
    expect(shouldAutoRetryJob(new WorkerWatchdogError(1000), 1, 5)).toBe(false);
    expect(shouldAutoRetryJob(new WorkerSlotBusyError(), 1, 5)).toBe(false);
  });

  it("treats gateway 502/503/504 as transient", () => {
    expect(isTransientNetworkError(new Error("upstream 502 Bad Gateway"))).toBe(true);
    expect(shouldAutoRetryJob(new Error("HTTP 504"), 1, 3)).toBe(true);
  });
});
