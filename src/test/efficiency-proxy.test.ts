import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  RateLimitError,
  efficiencyProxyStats,
  enforceRateLimit,
  requestFingerprint,
  resetEfficiencyProxy,
  setSharedProxyStore,
  runThroughEfficiencyProxy,
} from "@/lib/efficiency-proxy.server";

const base = {
  prompt: "Dark drill, 145 bpm",
  lyrics: "Aš einu per naktį",
  language: "lt",
  model: "V4_5",
};

beforeEach(() => {
  resetEfficiencyProxy();
  // Unit tests exercise the in-memory tier; the Supabase tier has its own suite.
  setSharedProxyStore(null);
});

describe("requestFingerprint", () => {
  it("collapses whitespace and casing in the brief", () => {
    expect(requestFingerprint({ ...base, prompt: "  dark   DRILL, 145 bpm " })).toBe(
      requestFingerprint(base),
    );
  });

  it("separates different lyrics, language, and mode", () => {
    const a = requestFingerprint(base);
    expect(requestFingerprint({ ...base, lyrics: "Kitas tekstas" })).not.toBe(a);
    expect(requestFingerprint({ ...base, language: "es" })).not.toBe(a);
    expect(requestFingerprint({ ...base, instrumental: true })).not.toBe(a);
    expect(requestFingerprint({ ...base, audioFormat: "wav" })).not.toBe(a);
  });

  it("preserves lyric casing and diacritics as distinct inputs", () => {
    expect(requestFingerprint({ ...base, lyrics: "AŠ EINU PER NAKTĮ" })).not.toBe(
      requestFingerprint(base),
    );
    expect(requestFingerprint({ ...base, lyrics: "As einu per nakti" })).not.toBe(
      requestFingerprint(base),
    );
  });
});

describe("dedupe + coalescing", () => {
  it("dispatches once and serves the cached result afterwards", async () => {
    const dispatch = vi.fn(async () => ({ taskId: "t1", status: "completed" }));
    const first = await runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch });
    const second = await runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(first.value);
  });

  it("coalesces concurrent identical requests into one upstream call", async () => {
    let resolveRun: (v: { taskId: string; status: string }) => void = () => {};
    const dispatch = vi.fn(
      () => new Promise<{ taskId: string; status: string }>((r) => (resolveRun = r)),
    );
    const runs = Promise.all([
      runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch }),
      runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch }),
      runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch }),
    ]);
    await Promise.resolve();
    resolveRun({ taskId: "t9", status: "completed" });
    const results = await runs;

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.cached)).toHaveLength(2);
    expect(results.every((r) => r.value.taskId === "t9")).toBe(true);
    expect(efficiencyProxyStats().inFlight).toBe(0);
  });

  it("does not cache failed renders", async () => {
    const dispatch = vi.fn(async () => ({ taskId: null, status: "failed" }));
    await runThroughEfficiencyProxy({
      userId: "u1",
      request: base,
      dispatch,
      cacheable: (v) => v.status !== "failed",
    });
    await runThroughEfficiencyProxy({
      userId: "u1",
      request: base,
      dispatch,
      cacheable: (v) => v.status !== "failed",
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("releases the slot when the dispatch throws", async () => {
    const dispatch = vi.fn(async () => {
      throw new Error("engine down");
    });
    await expect(
      runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch }),
    ).rejects.toThrow("engine down");
    expect(efficiencyProxyStats().activeRenders).toBe(0);
    expect(efficiencyProxyStats().inFlight).toBe(0);
  });

  it("expires cache entries after the TTL", async () => {
    const dispatch = vi.fn(async () => ({ taskId: "t1", status: "completed" }));
    const t0 = 1_000_000;
    await runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch, now: t0 });
    const later = await runThroughEfficiencyProxy({
      userId: "u1",
      request: base,
      dispatch,
      now: t0 + 31 * 60_000,
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(later.cached).toBe(false);
  });
});

describe("rate limiting", () => {
  it("allows the window quota then throws RateLimitError", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) enforceRateLimit("u1", t0 + i);
    expect(() => enforceRateLimit("u1", t0 + RATE_LIMIT_MAX)).toThrow(RateLimitError);
  });

  it("frees up once the window slides past", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) enforceRateLimit("u1", t0 + i);
    expect(() => enforceRateLimit("u1", t0 + RATE_LIMIT_WINDOW_MS + 1)).not.toThrow();
  });

  it("is scoped per user", () => {
    const t0 = 5_000_000;
    for (let i = 0; i < RATE_LIMIT_MAX; i += 1) enforceRateLimit("u1", t0 + i);
    expect(() => enforceRateLimit("u2", t0)).not.toThrow();
  });

  it("does not spend quota on a cache hit", async () => {
    const dispatch = vi.fn(async () => ({ taskId: "t1", status: "completed" }));
    for (let i = 0; i < RATE_LIMIT_MAX + 4; i += 1) {
      await runThroughEfficiencyProxy({ userId: "u1", request: base, dispatch });
    }
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
