import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadMock, insertMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async (..._args: unknown[]) => ({ data: { path: "masters/task" }, error: null })),
  insertMock: vi.fn(async () => ({ error: null })),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: uploadMock }) },
    from: () => ({ insert: insertMock }),
  }),
}));

import { maxDuration, POST, watchTrack } from "@/app/api/generate/route";
import { readTrackJob, resetTrackJobs, WAVESPEED_TRACK_WEBHOOK_URL } from "@/lib/wavespeed-track-jobs.server";

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
    uploadMock.mockClear();
    insertMock.mockClear();
    resetTrackJobs();
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
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SONG_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      output_format: "wav",
      gender: "male",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
  });

  it("returns pending with the task id and does not hold the request open", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: { id: "task-9" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(generateRequest({ title: "Heavy Sky", userId: "user-1" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      status: "pending",
      taskId: "task-9",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(body.webhook).toBe("https://hybrid-ai-records.com/api/ai/wavespeed-webhook");
    expect(readTrackJob("task-9")).toMatchObject({
      status: "processing",
      title: "Heavy Sky",
      userId: "user-1",
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("marks the job failed after 120 background result polls", async () => {
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

    const accepted = await POST(generateRequest());
    expect(accepted.status).toBe(200);
    const pending = watchTrack("task-4");
    for (let attempt = 0; attempt < 120; attempt++) {
      await vi.advanceTimersByTimeAsync(3000);
    }
    await pending;

    expect(polls).toBe(120);
    expect(readTrackJob("task-4")).toMatchObject({
      status: "failed",
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

  it("sends the vocal song fields plus the production webhook", async () => {
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
    const [songUrl, songInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(songUrl).toBe(SONG_URL);
    const songBody = JSON.parse(String(songInit.body)) as Record<string, unknown>;
    expect(songBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(Object.keys(songBody).sort()).toEqual(["gender", "lyrics", "output_format", "prompt", "webhook"]);
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
    const [voicedUrl, voicedInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(voicedUrl).toBe(SONG_URL);
    const voicedBody = JSON.parse(String(voicedInit.body)) as Record<string, unknown>;
    expect(voicedBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      vocal_id: "artist-voice-9",
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(voicedBody).not.toHaveProperty("gender");
    expect(voicedBody).not.toHaveProperty("title");
    expect(voicedBody).not.toHaveProperty("userId");
    expect(voicedBody).not.toHaveProperty("reference_id");

    fetchMock.mockClear();
    const blankVoice = await POST(
      generateRequest({ gender: "   ", vocalId: "   ", title: "Heavy Sky Arrival", userId: "user-1" }),
    );
    expect(blankVoice.status).toBe(500);
    const blankBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(blankBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "male",
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
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
    const [bgmUrl, bgmInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(bgmUrl).toBe(BGM_URL);
    const bgmBody = JSON.parse(String(bgmInit.body)) as Record<string, unknown>;
    expect(bgmBody).toEqual({
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(bgmBody.prompt).toBe("Heavy southern rock, 74 BPM");
    expect(String(bgmBody.prompt).match(/74 BPM/g)).toEqual(["74 BPM"]);
    expect(bgmBody).not.toHaveProperty("lyrics");
    expect(bgmBody).not.toHaveProperty("gender");
    expect(bgmBody).not.toHaveProperty("vocal_id");
    expect(bgmBody).not.toHaveProperty("reference_id");
  });

  it("adds reference_id only when referenceId is a non-empty string", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const vocal = await POST(generateRequest({ gender: "male", referenceId: "  ref-swamp  " }));
    expect(vocal.status).toBe(500);
    const vocalBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(vocalBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "male",
      output_format: "wav",
      reference_id: "ref-swamp",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(vocalBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const withVoice = await POST(
      generateRequest({
        gender: "female",
        vocalId: "  artist-voice-9  ",
        referenceId: "ref-voice",
      }),
    );
    expect(withVoice.status).toBe(500);
    const voicedBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(voicedBody).toEqual({
      prompt: "Acoustic, heavy rock",
      lyrics: "[Verse]\nline\n[inst-short]",
      vocal_id: "artist-voice-9",
      output_format: "wav",
      reference_id: "ref-voice",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(voicedBody).not.toHaveProperty("gender");

    fetchMock.mockClear();
    const instrumental = await POST(
      generateRequest({
        isInstrumental: true,
        referenceId: "ref-bgm",
        gender: "female",
        vocalId: "artist-voice-9",
        lyrics: "[Chorus]",
        prompt: "Heavy southern rock, 74 BPM",
      }),
    );
    expect(instrumental.status).toBe(500);
    const bgmBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(bgmBody).toEqual({
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
      reference_id: "ref-bgm",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
    expect(bgmBody).not.toHaveProperty("lyrics");
    expect(bgmBody).not.toHaveProperty("gender");
    expect(bgmBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const blank = await POST(generateRequest({ gender: "male", referenceId: "   " }));
    expect(blank.status).toBe(500);
    const blankBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(blankBody).not.toHaveProperty("reference_id");
    expect(blankBody.gender).toBe("male");
  });

  it("sends Male (m) as male and forwards the prompt unchanged", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const prompt = "soft female ballad, close piano, sung verse";

    const res = await POST(
      generateRequest({
        gender: "Male (m)",
        prompt,
        lyrics: "The room stays quiet",
        title: "Soft Ballad",
        isInstrumental: false,
      }),
    );

    expect(res.status).toBe(500);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(body.gender).toBe("male");
    expect(body.prompt).toBe(prompt);
    expect(body.prompt).not.toContain("gentle plucks");
    expect(body.prompt).not.toContain("Upright Bass");
    expect(body.prompt).not.toContain("warm resonance");
    expect(body.prompt).not.toContain("Stripped-down");
    expect(body).not.toHaveProperty("weirdness");
    expect(body).not.toHaveProperty("styleInfluence");
    expect(body).not.toHaveProperty("audioInfluence");
    expect(body).toEqual({
      prompt,
      lyrics: "The room stays quiet",
      gender: "male",
      output_format: "wav",
      webhook: WAVESPEED_TRACK_WEBHOOK_URL,
    });
  });
});
