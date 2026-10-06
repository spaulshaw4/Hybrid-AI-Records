import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadMock, insertMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async () => ({ data: { path: "masters/task" }, error: null })),
  insertMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: uploadMock }) },
    from: () => ({ insert: insertMock }),
  }),
}));

import { maxDuration, POST } from "@/app/api/generate/route";

const SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";

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

function generateRequest(extra: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: "Acoustic,  heavy rock",
      lyrics: "[Verse]\nline\n[inst]",
      ...extra,
    }),
  });
}

describe("POST /api/generate", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    uploadMock.mockClear();
    insertMock.mockClear();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
  });

  it("exports a 360 second max duration and does not require the key at import", () => {
    expect(maxDuration).toBe(360);
    expect(typeof POST).toBe("function");
  });

  it("returns 500 when the API key is missing and does not call upstream", async () => {
    delete process.env.WAVESPEED_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(generateRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Missing WaveSpeed API key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the queue response has no task id", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(generateRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: `WaveSpeed rejected: ${JSON.stringify({ data: {} })}`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SONG_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      output_format: "wav",
      gender: "male",
    });
  });

  it("returns 500 when upstream reports failed or cancelled", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-1" } });
        return jsonResponse({ data: { status: "failed" } });
      }),
    );

    const pending = POST(generateRequest());
    await vi.advanceTimersByTimeAsync(3000);
    const failed = await pending;
    expect(failed.status).toBe(500);
    await expect(failed.json()).resolves.toEqual({ error: "Generation failed upstream" });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-2" } });
        return jsonResponse({ data: { status: "cancelled" } });
      }),
    );
    const cancelledPending = POST(generateRequest());
    await vi.advanceTimersByTimeAsync(3000);
    const cancelled = await cancelledPending;
    expect(cancelled.status).toBe(500);
    await expect(cancelled.json()).resolves.toEqual({ error: "Generation failed upstream" });
  });

  it("skips a non-ok poll, vaults WAV and MP3, and does not return the CloudFront URL", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const wav = silentWav();
    const cloudfront = "https://cdn.example/master.wav";
    vi.useFakeTimers();
    let polls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("vocal-clone")) {
        throw new Error("vocal-clone must not run on generate");
      }
      if (url === SONG_URL) return jsonResponse({ data: { id: "task-3" } });
      if (url === cloudfront) return new Response(wav, { status: 200 });
      polls += 1;
      if (polls === 1) return new Response("unavailable", { status: 502 });
      return jsonResponse({
        data: { status: "completed", outputs: [cloudfront] },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = POST(generateRequest({ title: "Heavy Sky", userId: "user-1" }));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const wavUrl =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/task-3.wav";
    const mp3Url =
      "https://project.supabase.co/storage/v1/object/public/audio-vault/masters/task-3.mp3";
    expect(body).toEqual({ success: true, wavUrl, mp3Url });
    expect(body).not.toHaveProperty("audioUrl");
    expect(body).not.toHaveProperty("duration");
    expect(JSON.stringify(body)).not.toContain("cloudfront");
    expect(JSON.stringify(body)).not.toContain("cdn.example");

    const wavCall = uploadMock.mock.calls.find((call) => call[0] === "masters/task-3.wav");
    const mp3Call = uploadMock.mock.calls.find((call) => call[0] === "masters/task-3.mp3");
    expect(wavCall?.[2]).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(mp3Call?.[2]).toMatchObject({ contentType: "audio/mpeg", upsert: true });
    expect(Buffer.compare(Buffer.from(wavCall?.[1] as Uint8Array), wav)).toBe(0);
    expect((mp3Call?.[1] as Uint8Array).byteLength).toBeGreaterThan(0);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "user-1",
        title: "Heavy Sky",
        wav_url: wavUrl,
        mp3_url: mp3Url,
        task_id: "task-3",
      }),
    );
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("vocal-clone"))).toBe(false);
  });

  it("returns 500 when WAV transcode throws", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    vi.useFakeTimers();
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

    const pending = POST(generateRequest());
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; wavUrl?: string; audioUrl?: string };
    expect(body.error).toBeTruthy();
    expect(body.wavUrl).toBeUndefined();
    expect(body.audioUrl).toBeUndefined();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns 504 after 120 polls", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.useFakeTimers();
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-4" } });
        polls += 1;
        return jsonResponse({ data: { status: "processing" } });
      }),
    );

    const pending = POST(generateRequest());
    for (let attempt = 0; attempt < 120; attempt++) {
      await vi.advanceTimersByTimeAsync(3000);
    }
    const res = await pending;

    expect(polls).toBe(120);
    expect(res.status).toBe(504);
    await expect(res.json()).resolves.toEqual({
      error: "Task hit the 6-minute engine ceiling",
    });
  });

  it("returns 500 with the thrown message", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );

    const res = await POST(generateRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "socket hang up" });
  });

  it("sends exactly prompt, lyrics, gender, and output_format on vocal songs", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const vocal = await POST(
      generateRequest({
        gender: "female",
        title: "Heavy Sky Arrival",
        userId: "user-1",
        isInstrumental: false,
      }),
    );
    expect(vocal.status).toBe(500);
    const [songUrl, songInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(songUrl).toBe(SONG_URL);
    const songBody = JSON.parse(String(songInit.body)) as Record<string, unknown>;
    expect(songBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      output_format: "wav",
    });
    expect(Object.keys(songBody).sort()).toEqual(["gender", "lyrics", "output_format", "prompt"]);
    expect(songBody).not.toHaveProperty("title");
    expect(songBody).not.toHaveProperty("userId");
    expect(songBody).not.toHaveProperty("reference_id");
    expect(songBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const withVoice = await POST(
      generateRequest({
        gender: "female",
        vocalId: "  artist-voice-9  ",
        title: "Heavy Sky Arrival",
        userId: "user-1",
        isInstrumental: false,
      }),
    );
    expect(withVoice.status).toBe(500);
    const [voicedUrl, voicedInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(voicedUrl).toBe(SONG_URL);
    const voicedBody = JSON.parse(String(voicedInit.body)) as Record<string, unknown>;
    expect(voicedBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      output_format: "wav",
    });
    expect(voicedBody).not.toHaveProperty("vocal_id");
    expect(voicedBody).not.toHaveProperty("title");
    expect(voicedBody).not.toHaveProperty("userId");
    expect(voicedBody).not.toHaveProperty("reference_id");

    fetchMock.mockClear();
    const blankVoice = await POST(
      generateRequest({ gender: "   ", vocalId: "   ", title: "Heavy Sky Arrival", userId: "user-1" }),
    );
    expect(blankVoice.status).toBe(500);
    const blankBody = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(blankBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "male",
      output_format: "wav",
    });
    expect(blankBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const instrumental = await POST(
      generateRequest({
        isInstrumental: true,
        gender: "female",
        vocalId: "artist-voice-9",
        lyrics: "[intro-long]\n[inst-long]\n[Chorus - Double]\n[outro-long]\n[Final Chord]\n[Fade Out]",
        prompt: "Heavy southern rock, 74 BPM",
      }),
    );
    expect(instrumental.status).toBe(500);
    const [bgmUrl, bgmInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(bgmUrl).toBe(BGM_URL);
    const bgmBody = JSON.parse(String(bgmInit.body)) as Record<string, unknown>;
    expect(bgmBody).toEqual({
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
    });
    expect(bgmBody.prompt).toBe("Heavy southern rock, 74 BPM");
    expect(String(bgmBody.prompt).match(/74 BPM/g)).toEqual(["74 BPM"]);
    expect(bgmBody).not.toHaveProperty("lyrics");
    expect(bgmBody).not.toHaveProperty("gender");
    expect(bgmBody).not.toHaveProperty("vocal_id");
    expect(bgmBody).not.toHaveProperty("reference_id");
  });
});
