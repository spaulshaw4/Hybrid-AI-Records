import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPlayReporter,
  reportEngineExport,
  reportEnginePlay,
  sendEngineFeedback,
} from "@/lib/engine-feedback";

type Sent = { session_id: string; event: string; position_sec: number; duration_sec: number };

let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as Sent);
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sendEngineFeedback", () => {
  it("posts the verdict with keepalive so it survives an unload", async () => {
    await sendEngineFeedback({ session_id: "ht_1", event: "export" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ session_id: "ht_1", event: "export" });
    const init = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1];
    expect((init as RequestInit).keepalive).toBe(true);
  });

  it("never throws when the worker is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    await expect(sendEngineFeedback({ session_id: "ht_1", event: "export" })).resolves.toBe(false);
  });

  it("ignores a missing session id", async () => {
    await expect(sendEngineFeedback({ session_id: "  ", event: "export" })).resolves.toBe(false);
    expect(sent).toHaveLength(0);
  });
});

describe("reportEnginePlay", () => {
  it("skips when duration is unknown", async () => {
    reportEnginePlay("ht_1", 10, 0);
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });
});

describe("createPlayReporter", () => {
  it("emits exactly one verdict per listen, not one per pause", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(10, 100);
    r.flush();
    r.flush();
    r.flush();
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
  });

  it("reports the furthest point heard, not where playback stopped", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(90, 100);
    r.observe(5, 100); // user scrubbed back
    r.flush();
    await flushMicrotasks();
    expect(sent[0].position_sec).toBe(90);
  });

  it("a full playthrough reports the whole duration", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(50, 100);
    r.complete(100);
    await flushMicrotasks();
    expect(sent[0]).toMatchObject({ position_sec: 100, duration_sec: 100, event: "play" });
  });

  it("an early skip still reports, so the negative signal survives", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(3, 100);
    r.flush();
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    expect(sent[0].position_sec).toBe(3);
  });

  it("a metadata-only load is not reported as a zero-second skip", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(0, 100); // loadedmetadata fired, nothing played
    r.flush();
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });

  it("reset reports the previous track then starts clean", async () => {
    const r = createPlayReporter(() => "ht_1");
    r.observe(80, 100);
    r.reset();
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    r.observe(20, 100);
    r.flush();
    await flushMicrotasks();
    expect(sent).toHaveLength(2);
    expect(sent[1].position_sec).toBe(20);
  });

  it("stays silent without a session id", async () => {
    const r = createPlayReporter(() => null);
    r.observe(50, 100);
    r.flush();
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });
});

describe("reportEngineExport", () => {
  it("sends a positive with no playback numbers", async () => {
    reportEngineExport("ht_9");
    await flushMicrotasks();
    expect(sent[0]).toMatchObject({ session_id: "ht_9", event: "export" });
  });

  it("ignores a null session", async () => {
    reportEngineExport(null);
    await flushMicrotasks();
    expect(sent).toHaveLength(0);
  });
});
