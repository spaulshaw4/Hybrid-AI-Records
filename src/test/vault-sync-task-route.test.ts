import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, uploadMock, insertMock, limitMock, resolveStudioSessionMock, fromMock } = vi.hoisted(
  () => ({
    createClientMock: vi.fn(),
    uploadMock: vi.fn(async () => ({ data: { path: "masters/task" }, error: null })),
    insertMock: vi.fn(async () => ({ error: null })),
    limitMock: vi.fn(async () => ({ data: [], error: null })),
    resolveStudioSessionMock: vi.fn(),
    fromMock: vi.fn(),
  }),
);

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
}));

import { POST } from "@/app/api/vault/sync-task/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SUPABASE_URL = "https://project.supabase.co";
const AUDIO = "https://cdn.example/sync.wav";
const TASK_ID = "task-sync";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function silentWav(): Buffer {
  const channels = 1;
  const sampleRate = 44100;
  const frames = 1152;
  const dataLen = frames * channels * 2;
  const buffer = Buffer.alloc(44 + dataLen);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLen, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLen, 40);
  return buffer;
}

function syncRequest(body: Record<string, unknown>, authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vault/sync-task", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/vault/sync-task", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const stored: Array<{ wav_url: string; mp3_url: string }> = [];

  beforeEach(() => {
    stored.length = 0;
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    createClientMock.mockImplementation(() => ({
      storage: { from: () => ({ upload: uploadMock }) },
      from: (table: string) => {
        fromMock(table);
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => limitMock(),
              }),
            }),
          }),
          insert: (row: { wav_url?: string; mp3_url?: string }) => insertMock(row),
        };
      },
    }));
    limitMock.mockImplementation(async () => ({ data: stored.map((row) => ({ ...row })), error: null }));
    insertMock.mockImplementation(async (row: { wav_url?: string; mp3_url?: string }) => {
      stored.push({ wav_url: String(row.wav_url), mp3_url: String(row.mp3_url) });
      return { error: null };
    });
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    createClientMock.mockReset();
    uploadMock.mockClear();
    insertMock.mockReset();
    limitMock.mockReset();
    fromMock.mockReset();
    resolveStudioSessionMock.mockReset();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
    if (originalAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnon;
  });

  it("returns 401 without a session and does not poll", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not poll");
    });
    vi.stubGlobal("fetch", fetchMock);

    const missing = await POST(syncRequest({ taskId: TASK_ID, userId: OTHER_USER }));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized session" });

    resolveStudioSessionMock.mockRejectedValue(
      Object.assign(new Error("Unauthorized session"), { name: "UnauthorizedSessionError", status: 401 }),
    );
    const rejected = await POST(
      syncRequest({ taskId: TASK_ID, userId: OTHER_USER }, "Bearer a.b.c"),
    );
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized session" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("polls the result endpoint and does not fetch a caller-supplied URL", async () => {
    const wav = silentWav();
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("evil.example") || href.includes("169.254.169.254")) {
        throw new Error("caller url downloaded");
      }
      if (href === AUDIO) {
        const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
        return new Response(copy, { status: 200 });
      }
      if (href === `https://api.wavespeed.ai/api/v3/predictions/${TASK_ID}/result`) {
        return jsonResponse({
          data: {
            status: "completed",
            title: "The Wind",
            prompt: "open air",
            lyrics: "like the wind",
            outputs: [AUDIO],
          },
        });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      syncRequest(
        {
          taskId: TASK_ID,
          userId: OTHER_USER,
          outputs: ["https://evil.example/caller.wav"],
          url: "https://evil.example/caller.wav",
        },
        "Bearer a.b.c",
      ),
    );

    expect(res.status).toBe(200);
    const wavUrl = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/${TASK_ID}.wav`;
    const mp3Url = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/${TASK_ID}.mp3`;
    await expect(res.json()).resolves.toEqual({
      success: true,
      status: "completed",
      taskId: TASK_ID,
      wavUrl,
      mp3Url,
    });

    const resultCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === `https://api.wavespeed.ai/api/v3/predictions/${TASK_ID}/result`,
    );
    expect(resultCalls).toHaveLength(1);
    const init = resultCalls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => call[0] === AUDIO)).toBe(true);

    const wavCall = uploadMock.mock.calls.find((call) => call[0] === `masters/${TASK_ID}.wav`);
    const mp3Call = uploadMock.mock.calls.find((call) => call[0] === `masters/${TASK_ID}.mp3`);
    expect(wavCall?.[2]).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(mp3Call?.[2]).toMatchObject({ contentType: "audio/mpeg", upsert: true });
    expect(Buffer.compare(Buffer.from(wavCall?.[1] as Uint8Array), wav)).toBe(0);
    const mp3Bytes = Buffer.from(mp3Call?.[1] as Uint8Array);
    expect(mp3Bytes[0]).toBe(0xff);
    expect(mp3Bytes[1]! & 0xe0).toBe(0xe0);

    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");
    expect(fromMock.mock.calls.every((call) => call[0] === "vaulted_tracks")).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith({
      user_id: SESSION_USER,
      title: "The Wind",
      prompt: "open air",
      lyrics: "like the wind",
      vocal_id_used: null,
      wav_url: wavUrl,
      mp3_url: mp3Url,
      task_id: TASK_ID,
    });
    for (const call of createClientMock.mock.calls) {
      expect(call).toEqual([SUPABASE_URL, "service-role-test"]);
    }
    expect(createClientMock.mock.calls.some((call) => call[1] === "anon-test")).toBe(false);
  });

  it("does not download an http URL or a predictions result URL", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("169.254.169.254")) throw new Error("http url downloaded");
      if (href === "https://api.wavespeed.ai/api/v3/predictions/task-http/result") {
        return jsonResponse({
          data: { status: "completed", outputs: ["http://169.254.169.254/latest/meta-data"] },
        });
      }
      if (href === "https://api.wavespeed.ai/api/v3/predictions/task-loop/result") {
        return jsonResponse({
          data: {
            status: "completed",
            outputs: ["https://api.wavespeed.ai/api/v3/predictions/task-loop/result"],
          },
        });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const httpRes = await POST(syncRequest({ taskId: "task-http" }, "Bearer a.b.c"));
    expect(httpRes.status).toBe(422);
    await expect(httpRes.json()).resolves.toEqual({ error: "Generation failed upstream" });

    const loopRes = await POST(syncRequest({ id: "task-loop" }, "Bearer a.b.c"));
    expect(loopRes.status).toBe(422);
    await expect(loopRes.json()).resolves.toEqual({ error: "Generation failed upstream" });

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("169.254.169.254"))).toHaveLength(0);
    expect(
      fetchMock.mock.calls.filter(
        (call) => call[0] === "https://api.wavespeed.ai/api/v3/predictions/task-loop/result",
      ),
    ).toHaveLength(1);
    expect(uploadMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("does not insert a second row for the same task id", async () => {
    const wav = silentWav();
    const fetchMock = vi.fn(async (url: string) => {
      const href = String(url);
      if (href.includes("evil.example")) throw new Error("caller url downloaded");
      if (href === AUDIO) {
        const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
        return new Response(copy, { status: 200 });
      }
      if (href === `https://api.wavespeed.ai/api/v3/predictions/${TASK_ID}/result`) {
        return jsonResponse({
          data: { status: "completed", title: "The Wind", outputs: [AUDIO] },
        });
      }
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = await POST(
      syncRequest({ id: TASK_ID, userId: OTHER_USER, outputs: ["https://evil.example/caller.wav"] }, "Bearer a.b.c"),
    );
    const second = await POST(
      syncRequest({ taskId: TASK_ID, userId: OTHER_USER, outputs: ["https://evil.example/again.wav"] }, "Bearer a.b.c"),
    );

    const wavUrl = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/${TASK_ID}.wav`;
    const mp3Url = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/${TASK_ID}.mp3`;
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      success: true,
      status: "completed",
      taskId: TASK_ID,
      wavUrl,
      mp3Url,
    });
    await expect(second.json()).resolves.toEqual({
      success: true,
      status: "completed",
      taskId: TASK_ID,
      wavUrl,
      mp3Url,
    });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.filter((call) => call[0] === AUDIO)).toHaveLength(1);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(false);
  });
});
