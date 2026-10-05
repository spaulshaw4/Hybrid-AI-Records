import { afterEach, describe, expect, it, vi } from "vitest";

import { maxDuration, POST } from "@/app/api/generate/route";

const SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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
    await expect(res.json()).resolves.toEqual({ error: "Task submission rejected by upstream" });
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

  it("skips a non-ok poll and returns the completed audio url", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.useFakeTimers();
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-3" } });
        polls += 1;
        if (polls === 1) return new Response("unavailable", { status: 502 });
        return jsonResponse({
          data: { status: "completed", outputs: ["https://cdn.example/master.wav"] },
        });
      }),
    );

    const pending = POST(generateRequest());
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(3000);
    const res = await pending;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      audioUrl: "https://cdn.example/master.wav",
    });
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

  it("sends gender only on vocal songs and omits lyrics on instrumental", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const vocal = await POST(
      generateRequest({ gender: "female", title: "Heavy Sky Arrival", isInstrumental: false }),
    );
    expect(vocal.status).toBe(500);
    const [songUrl, songInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(songUrl).toBe(SONG_URL);
    const songBody = JSON.parse(String(songInit.body)) as Record<string, unknown>;
    expect(songBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      output_format: "wav",
      gender: "female",
    });
    expect(songBody).not.toHaveProperty("title");
    expect(songBody).not.toHaveProperty("reference_id");
    expect(songBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const instrumental = await POST(
      generateRequest({
        isInstrumental: true,
        gender: "female",
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
  });
});
