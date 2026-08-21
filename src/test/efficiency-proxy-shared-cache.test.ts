import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetEfficiencyProxy,
  runThroughEfficiencyProxy,
  setSharedProxyStore,
  type SharedProxyStore,
} from "@/lib/efficiency-proxy.server";

const request = {
  prompt: "Heavy rock about a frozen oak",
  lyrics: "[Verse]\nZiema uzsalo",
  language: "lt",
};

/** Stands in for the Supabase table: shared by every simulated instance. */
function makeStore() {
  const rows = new Map<string, { value: unknown; expiresAt: number }>();
  const store: SharedProxyStore = {
    read: async (fingerprint, now) => {
      const row = rows.get(fingerprint);
      if (!row || row.expiresAt <= now) return null;
      return row.value;
    },
    write: async (fingerprint, value, expiresAt) => {
      rows.set(fingerprint, { value, expiresAt });
    },
    purge: async (now) => {
      for (const [k, v] of rows) if (v.expiresAt <= now) rows.delete(k);
    },
  };
  return { rows, store };
}

describe("efficiency proxy shared cache tier", () => {
  beforeEach(() => resetEfficiencyProxy());

  it("persists a rendered result into the shared store", async () => {
    const { rows, store } = makeStore();
    setSharedProxyStore(store);
    const dispatch = vi.fn().mockResolvedValue({ taskId: "t1" });

    const out = await runThroughEfficiencyProxy({ userId: "u1", request, dispatch });

    expect(out.cached).toBe(false);
    // The write is fire-and-forget; let the microtask queue drain.
    await Promise.resolve();
    expect(rows.get(out.fingerprint)?.value).toEqual({ taskId: "t1" });
  });

  it("serves a hit from another instance after a restart wipes memory", async () => {
    const { store } = makeStore();
    setSharedProxyStore(store);
    const first = vi.fn().mockResolvedValue({ taskId: "t1" });
    await runThroughEfficiencyProxy({ userId: "u1", request, dispatch: first });
    await Promise.resolve();

    // New instance: in-memory state is gone, the shared row is not.
    resetEfficiencyProxy();
    setSharedProxyStore(store);
    const second = vi.fn().mockResolvedValue({ taskId: "t2" });
    const out = await runThroughEfficiencyProxy({ userId: "u2", request, dispatch: second });

    expect(second).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
    expect(out.value).toEqual({ taskId: "t1" });
  });

  it("ignores expired shared rows and re-renders", async () => {
    const { rows, store } = makeStore();
    setSharedProxyStore(store);
    const dispatch = vi.fn().mockResolvedValue({ taskId: "fresh" });
    const stale = await runThroughEfficiencyProxy({ userId: "u1", request, dispatch });
    await Promise.resolve();
    rows.set(stale.fingerprint, { value: { taskId: "old" }, expiresAt: Date.now() - 1 });

    resetEfficiencyProxy();
    setSharedProxyStore(store);
    const out = await runThroughEfficiencyProxy({ userId: "u1", request, dispatch });

    expect(out.cached).toBe(false);
    expect(out.value).toEqual({ taskId: "fresh" });
  });

  it("falls back to a normal render when the shared store errors", async () => {
    setSharedProxyStore({
      read: async () => {
        throw new Error("db down");
      },
      write: async () => {
        throw new Error("db down");
      },
    });
    const dispatch = vi.fn().mockResolvedValue({ taskId: "t1" });

    await expect(
      runThroughEfficiencyProxy({ userId: "u1", request, dispatch }),
    ).resolves.toMatchObject({ cached: false, value: { taskId: "t1" } });
  });
});
