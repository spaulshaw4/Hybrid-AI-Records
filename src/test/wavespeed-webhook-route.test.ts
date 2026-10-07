import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { uploadMock, insertMock, resolveStudioSessionMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async (..._args: unknown[]) => ({ data: { path: "masters/task" }, error: null })),
  insertMock: vi.fn(async () => ({ error: null })),
  resolveStudioSessionMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: uploadMock }) },
    from: (table: string) => {
      if (table === "token_balances") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { balance: 3 }, error: null }),
            }),
          }),
        };
      }
      return { insert: insertMock };
    },
    rpc: async () => ({
      data: [{ ok: true, balance: 2, already_applied: false }],
      error: null,
    }),
  }),
}));

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
}));

import { POST as generatePost } from "@/app/api/generate/route";
import { GET, POST as webhookPost } from "@/app/api/ai/wavespeed-webhook/route";
import { readTrackJob, resetTrackJobs } from "@/lib/wavespeed-track-jobs.server";

const SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";

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

function wav24(): Buffer {
  const dataLen = 6;
  const buffer = Buffer.alloc(44 + dataLen);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataLen, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(44100 * 3, 28);
  buffer.writeUInt16LE(3, 32);
  buffer.writeUInt16LE(24, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataLen, 40);
  return buffer;
}

function generateRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer a.b.c" },
    body: JSON.stringify({
      prompt: "Acoustic,  heavy rock",
      lyrics: "[Verse]\nline\n[inst]",
      ...extra,
    }),
  });
}

function webhookRequest(body: unknown): Request {
  return new Request("https://hybrid-ai-records.com/api/ai/wavespeed-webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/wavespeed-webhook", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let sessionUserId = "user-1";

  beforeEach(() => {
    sessionUserId = "user-1";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockImplementation(async () => ({ userId: sessionUserId }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    uploadMock.mockClear();
    insertMock.mockClear();
    resolveStudioSessionMock.mockReset();
    resetTrackJobs();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  });

  it("ignores an unknown task and does not fetch its output URL", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await webhookPost(
      webhookRequest({
        id: "not-ours",
        status: "completed",
        outputs: ["https://evil.example/secret.wav"],
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("marks failed and cancelled predictions without vaulting", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-1" } });
        return jsonResponse({ data: { status: "failed" } });
      }),
    );
    const accepted = await generatePost(generateRequest());
    expect(accepted.status).toBe(200);

    const failed = await webhookPost(webhookRequest({ data: { id: "task-1", status: "completed" } }));
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toEqual({ received: true });
    expect(readTrackJob("task-1")).toMatchObject({
      status: "failed",
      error: "Generation failed upstream",
    });
    expect(uploadMock).not.toHaveBeenCalled();

    resetTrackJobs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-2" } });
        return jsonResponse({ data: { status: "cancelled" } });
      }),
    );
    await generatePost(generateRequest());
    await webhookPost(webhookRequest({ id: "task-2" }));
    expect(readTrackJob("task-2")?.status).toBe("failed");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("skips a non-ok result poll, then vaults WAV and MP3 from the result URL", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    vi.useFakeTimers();
    const wav = silentWav();
    const cloudfront = "https://cdn.example/master.wav";
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (String(url).includes("vocal-clone")) {
        throw new Error("vocal-clone must not run on generate");
      }
      if (url === SONG_URL) return jsonResponse({ data: { id: "task-3" } });
      if (url === cloudfront) {
        const copy = wav.buffer.slice(
          wav.byteOffset,
          wav.byteOffset + wav.byteLength,
        ) as ArrayBuffer;
        return new Response(copy, { status: 200 });
      }
      polls += 1;
      // Result polls retry 5 times (6 attempts) before the watcher gives up on this read.
      if (polls <= 6) return new Response("unavailable", { status: 502 });
      return jsonResponse({
        data: { status: "completed", outputs: [cloudfront] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const accepted = await generatePost(generateRequest({ title: "Heavy Sky", userId: "user-1" }));
    expect(accepted.status).toBe(200);

    const firstPromise = webhookPost(
      webhookRequest({
        data: { id: "task-3", status: "completed", outputs: ["https://evil.example/not-this.wav"] },
      }),
    );
    await vi.runAllTimersAsync();
    const first = await firstPromise;
    expect(first.status).toBe(200);
    expect(readTrackJob("task-3")?.status).toBe("processing");
    expect(uploadMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("evil.example"))).toBe(false);

    const second = await webhookPost(webhookRequest({ id: "task-3" }));
    expect(second.status).toBe(200);
    const wavUrl =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/task-3.wav";
    const mp3Url =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/task-3.mp3";
    expect(readTrackJob("task-3")).toMatchObject({ status: "completed", wavUrl, mp3Url });

    const wavCall = uploadMock.mock.calls.find((call) => call[0] === "masters/task-3.wav");
    const mp3Call = uploadMock.mock.calls.find((call) => call[0] === "masters/task-3.mp3");
    expect(wavCall?.[2]).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(mp3Call?.[2]).toMatchObject({ contentType: "audio/mpeg", upsert: true });
    expect(Buffer.compare(Buffer.from(wavCall?.[1] as Uint8Array), wav)).toBe(0);
    const mp3Bytes = Buffer.from(mp3Call?.[1] as Uint8Array);
    expect(mp3Bytes.byteLength).toBeGreaterThan(0);
    expect(mp3Bytes[0]).toBe(0xff);
    expect(mp3Bytes[1]! & 0xe0).toBe(0xe0);
    expect(mp3Bytes.toString("utf8")).not.toContain("[object Blob]");
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        title: "Heavy Sky",
        wav_url: wavUrl,
        mp3_url: mp3Url,
        task_id: "task-3",
      }),
    );

    const resultUrl = "https://api.wavespeed.ai/api/v3/predictions/task-3/result";
    const resultCalls = fetchMock.mock.calls.filter((call) => call[0] === resultUrl);
    expect(resultCalls.length).toBeGreaterThanOrEqual(7);
    expect(resultCalls.every((call) => ((call as [string, RequestInit?])[1])?.method === "GET")).toBe(true);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/v1/mureka"))).toBe(false);

    const status = await GET(new Request("http://localhost/api/ai/wavespeed-webhook?taskId=task-3"));
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody).toEqual({
      status: "completed",
      taskId: "task-3",
      wavUrl,
      mp3Url,
    });
    expect(statusBody).not.toHaveProperty("prompt");
    expect(statusBody).not.toHaveProperty("lyrics");
    expect(JSON.stringify(statusBody)).not.toContain("cdn.example");

    uploadMock.mockClear();
    await webhookPost(webhookRequest({ id: "task-3", status: "completed", outputs: [cloudfront] }));
    expect(uploadMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("vocal-clone"))).toBe(false);
  });

  it("records a transcode failure and does not upload", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-bad" } });
        if (url === "https://cdn.example/bad.wav") return new Response("not-a-wav", { status: 200 });
        return jsonResponse({
          data: { status: "completed", outputs: ["https://cdn.example/bad.wav"] },
        });
      }),
    );

    await generatePost(generateRequest());
    const res = await webhookPost(webhookRequest({ id: "task-bad" }));

    expect(res.status).toBe(200);
    const job = readTrackJob("task-bad");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("Invalid WAV: Buffer smaller than 44 bytes.");
    expect(job?.wavUrl).toBeUndefined();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("stores a non-16-bit WAV as audio/wav and points mp3Url at that file", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const wav = wav24();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-24" } });
        if (url === "https://cdn.example/wide.wav") {
          const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
          return new Response(copy, { status: 200 });
        }
        return jsonResponse({
          data: { status: "completed", outputs: ["https://cdn.example/wide.wav"] },
        });
      }),
    );

    sessionUserId = "user-24";
    await generatePost(generateRequest({ title: "Wide Take", userId: "user-24" }));
    const res = await webhookPost(webhookRequest({ id: "task-24" }));
    expect(res.status).toBe(200);

    const wavUrl =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/task-24.wav";
    expect(readTrackJob("task-24")).toMatchObject({
      status: "completed",
      wavUrl,
      mp3Url: wavUrl,
    });
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const wavCall = uploadMock.mock.calls[0];
    expect(wavCall?.[0]).toBe("masters/task-24.wav");
    expect(wavCall?.[2]).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(Buffer.compare(Buffer.from(wavCall?.[1] as Uint8Array), wav)).toBe(0);
    expect(uploadMock.mock.calls.some((call) => call[2] && (call[2] as { contentType?: string }).contentType === "audio/mpeg")).toBe(
      false,
    );
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-24",
        wav_url: wavUrl,
        mp3_url: wavUrl,
        task_id: "task-24",
      }),
    );
  });

  it("rejects a non-https result URL", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === SONG_URL) return jsonResponse({ data: { id: "task-http" } });
      return jsonResponse({
        data: { status: "completed", outputs: ["http://169.254.169.254/latest/meta-data"] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await generatePost(generateRequest());
    await webhookPost(webhookRequest({ id: "task-http" }));

    expect(readTrackJob("task-http")).toMatchObject({
      status: "failed",
      error: "Generation failed upstream",
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("169.254.169.254"))).toBe(false);
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
