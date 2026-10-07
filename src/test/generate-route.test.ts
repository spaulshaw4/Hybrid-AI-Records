import { afterEach, describe, expect, it, vi } from "vitest";

const { uploadMock, insertMock, fromMock } = vi.hoisted(() => ({
  uploadMock: vi.fn(async (..._args: unknown[]) => ({ data: { path: "masters/task" }, error: null })),
  insertMock: vi.fn(async () => ({ error: null })),
  fromMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: uploadMock }) },
    from: (table: string) => {
      fromMock(table);
      return { insert: insertMock };
    },
  }),
}));

import { maxDuration, POST, settleTrackFromWaveSpeed, watchTrack } from "@/app/api/generate/route";
import { readTrackJob, resetTrackJobs } from "@/lib/wavespeed-track-jobs.server";

const SONG_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song";
const BGM_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-bgm";
const MALE_VOCAL_LEAD = "Deep soulful male vocal, baritone delivery, ";
const FEMALE_VOCAL_LEAD = "Female vocal, ";
const DEFAULT_STYLE = "Acoustic, heavy rock";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FORBIDDEN_UPSTREAM_KEYS = ["webhook", "duration", "seed", "vocal_id", "reference_id"] as const;

function expectLockedPayload(body: Record<string, unknown>, expected: Record<string, unknown>) {
  const withSong =
    typeof expected.lyrics === "string"
      ? { lyrics_type: "custom", title: "Untitled", gender: "male", ...expected }
      : expected;
  expect(body).toEqual(withSong);
  for (const key of FORBIDDEN_UPSTREAM_KEYS) {
    expect(body).not.toHaveProperty(key);
  }
  const serialized = JSON.stringify(body);
  expect(serialized).not.toMatch(/\/v1\/mureka/);
  expect(serialized).not.toMatch(/Neon rain falls softly tonight|dreamy synth-pop|warm female vocal|cinematic chorus/i);
  expect(body.prompt).not.toBe("");
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
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    uploadMock.mockClear();
    insertMock.mockClear();
    fromMock.mockClear();
    resetTrackJobs();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
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
    await expect(res.json()).resolves.toEqual({ error: "Missing API key" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 when the queue response has no task id", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(generateRequest());

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "Failed to queue the master." });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SONG_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expectLockedPayload(JSON.parse(String(init.body)) as Record<string, unknown>, {
      prompt: `${MALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      output_format: "wav",
    });
  });

  it("returns pending with the task id and does not hold the request open", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (_url: string) => jsonResponse({ data: { id: "task-9" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(generateRequest({ title: "Heavy Sky", userId: "user-1" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      status: "pending",
      taskId: "task-9",
      requestId: "task-9",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(body, {
      prompt: `${MALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      title: "Heavy Sky",
      output_format: "wav",
    });
    expect(String((fetchMock.mock.calls[0] as [string, RequestInit?])[0])).not.toContain("/v1/mureka");
    expect(readTrackJob("task-9")).toMatchObject({
      status: "processing",
      title: "Heavy Sky",
      userId: "user-1",
    });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("accepts a code 200 envelope and a body that already has an id", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ code: 200, data: { id: "task-code" } }))
      .mockResolvedValueOnce(jsonResponse({ id: "task-bare", status: "created" }));
    vi.stubGlobal("fetch", fetchMock);

    const coded = await POST(generateRequest({ gender: "male" }));
    expect(coded.status).toBe(200);
    await expect(coded.json()).resolves.toEqual({
      success: true,
      status: "pending",
      taskId: "task-code",
      requestId: "task-code",
    });

    const bare = await POST(generateRequest({ gender: "female" }));
    expect(bare.status).toBe(200);
    await expect(bare.json()).resolves.toEqual({
      success: true,
      status: "pending",
      taskId: "task-bare",
      requestId: "task-bare",
    });
    const bareBody = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(bareBody.gender).toBe("female");
    expect(bareBody).not.toHaveProperty("webhook");
  });

  it("marks the job failed when the backoff poll reaches 60 minutes", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => new AbortController().signal);
    vi.spyOn(console, "log").mockImplementation(() => {});
    let polls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === SONG_URL) return jsonResponse({ code: 200, data: { id: "task-4" } });
        expect(url).toBe("https://api.wavespeed.ai/api/v3/predictions/task-4/result");
        expect(url).not.toContain("/v1/mureka");
        expect(init?.method).toBe("GET");
        polls += 1;
        return jsonResponse({ data: { status: "processing" } });
      }),
    );

    const accepted = await POST(generateRequest());
    expect(accepted.status).toBe(200);
    const pending = watchTrack("task-4");
    await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
    await pending;

    expect(polls).toBeGreaterThan(1);
    expect(readTrackJob("task-4")).toMatchObject({
      status: "failed",
      error: "Task hit the 60-minute engine ceiling",
    });
  }, 20_000);

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

  it("sends lyrics, wav output, and prompt or gender only when set", async () => {
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
    expect(vocal.status).toBe(502);
    const [songUrl, songInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(songUrl).toBe(SONG_URL);
    const songBody = JSON.parse(String(songInit.body)) as Record<string, unknown>;
    expectLockedPayload(songBody, {
      prompt: `${FEMALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      title: "Heavy Sky Arrival",
      output_format: "wav",
    });
    expect(Object.keys(songBody).sort()).toEqual([
      "gender",
      "lyrics",
      "lyrics_type",
      "output_format",
      "prompt",
      "title",
    ]);
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
    expect(withVoice.status).toBe(502);
    const [voicedUrl, voicedInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(voicedUrl).toBe(SONG_URL);
    const voicedBody = JSON.parse(String(voicedInit.body)) as Record<string, unknown>;
    expectLockedPayload(voicedBody, {
      prompt: `${FEMALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      title: "Heavy Sky Arrival",
      output_format: "wav",
    });
    expect(voicedBody).not.toHaveProperty("vocal_id");
    expect(voicedBody).not.toHaveProperty("userId");
    expect(voicedBody).not.toHaveProperty("reference_id");

    fetchMock.mockClear();
    const blankVoice = await POST(
      generateRequest({ gender: "   ", vocalId: "   ", title: "Heavy Sky Arrival", userId: "user-1" }),
    );
    expect(blankVoice.status).toBe(502);
    const blankBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(blankBody, {
      prompt: `${MALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      title: "Heavy Sky Arrival",
      output_format: "wav",
    });
    expect(blankBody.gender).toBe("male");
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
    expect(instrumental.status).toBe(502);
    const [bgmUrl, bgmInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(bgmUrl).toBe(BGM_URL);
    const bgmBody = JSON.parse(String(bgmInit.body)) as Record<string, unknown>;
    expectLockedPayload(bgmBody, {
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
    });
    expect(bgmBody.prompt).toBe("Heavy southern rock, 74 BPM");
    expect(String(bgmBody.prompt).match(/74 BPM/g)).toEqual(["74 BPM"]);
    expect(String(bgmBody.prompt)).not.toMatch(/\bmale vocal\b|\bbaritone\b|\bfemale vocal\b/i);
    expect(bgmBody).not.toHaveProperty("lyrics");
    expect(bgmBody).not.toHaveProperty("gender");
    expect(bgmBody).not.toHaveProperty("vocal_id");
    expect(bgmBody).not.toHaveProperty("reference_id");
  });

  it("never sends reference_id or vocal_id on generate-song or generate-bgm", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const vocal = await POST(generateRequest({ gender: "male", referenceId: "  ref-swamp  " }));
    expect(vocal.status).toBe(502);
    const vocalBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(vocalBody, {
      prompt: `${MALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "male",
      output_format: "wav",
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
    expect(withVoice.status).toBe(502);
    const voicedBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(voicedBody, {
      prompt: `${FEMALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      gender: "female",
      output_format: "wav",
    });
    expect(voicedBody).not.toHaveProperty("vocal_id");

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
    expect(instrumental.status).toBe(502);
    const bgmBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(bgmBody, {
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
    });
    expect(bgmBody).not.toHaveProperty("lyrics");
    expect(bgmBody).not.toHaveProperty("gender");
    expect(bgmBody).not.toHaveProperty("vocal_id");

    fetchMock.mockClear();
    const blank = await POST(generateRequest({ gender: "male", referenceId: "   " }));
    expect(blank.status).toBe(502);
    const blankBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(blankBody).not.toHaveProperty("reference_id");
    expect(blankBody.gender).toBe("male");
  });

  it("sends Male (m) as male and leads the prompt with baritone delivery", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const prompt = "Atmospheric downtempo soul, Rhodes piano, 75 BPM";
    const sentPrompt = `${MALE_VOCAL_LEAD}${prompt}`;

    const res = await POST(
      generateRequest({
        gender: "Male (m)",
        prompt,
        lyrics: "The room stays quiet",
        title: "Soft Ballad",
        isInstrumental: false,
      }),
    );

    expect(res.status).toBe(502);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(body.gender).toBe("male");
    expect(String(body.prompt).startsWith(MALE_VOCAL_LEAD)).toBe(true);
    expect(String(body.prompt).endsWith(prompt)).toBe(true);
    expect(body.prompt).not.toContain("gentle plucks");
    expect(body.prompt).not.toContain("Upright Bass");
    expect(body.prompt).not.toContain("warm resonance");
    expect(body.prompt).not.toContain("Stripped-down");
    expect(body).not.toHaveProperty("weirdness");
    expect(body).not.toHaveProperty("styleInfluence");
    expect(body).not.toHaveProperty("audioInfluence");
    expectLockedPayload(body, {
      prompt: sentPrompt,
      lyrics: "The room stays quiet",
      gender: "male",
      title: "Soft Ballad",
      output_format: "wav",
    });

    async function submittedPrompt(extra: Record<string, unknown>): Promise<Record<string, unknown>> {
      fetchMock.mockClear();
      const next = await POST(generateRequest(extra));
      expect(next.status).toBe(502);
      return JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
        string,
        unknown
      >;
    }

    const alreadyMale = await submittedPrompt({
      gender: "Male (m)",
      prompt: "male vocal, close piano, 75 BPM",
      lyrics: "The room stays quiet",
    });
    expect(alreadyMale.gender).toBe("male");
    expect(alreadyMale.prompt).toBe("male vocal, close piano, 75 BPM");

    const alreadyBaritone = await submittedPrompt({
      gender: "male",
      prompt: "dusty baritone, Rhodes piano, 75 BPM",
      lyrics: "The room stays quiet",
    });
    expect(alreadyBaritone.gender).toBe("male");
    expect(alreadyBaritone.prompt).toBe("dusty baritone, Rhodes piano, 75 BPM");

    const female = await submittedPrompt({
      gender: "female",
      prompt,
      lyrics: "The room stays quiet",
    });
    expect(female.gender).toBe("female");
    expect(female.prompt).toBe(`${FEMALE_VOCAL_LEAD}${prompt}`);

    const alreadyFemale = await submittedPrompt({
      gender: "female",
      prompt: "Female vocal, close piano, 75 BPM",
      lyrics: "The room stays quiet",
    });
    expect(alreadyFemale.gender).toBe("female");
    expect(alreadyFemale.prompt).toBe("Female vocal, close piano, 75 BPM");

    const instrumental = await submittedPrompt({
      isInstrumental: true,
      gender: "female",
      prompt: "Heavy southern rock, 74 BPM",
      lyrics: "[Chorus]",
    });
    expect(instrumental.prompt).toBe("Heavy southern rock, 74 BPM");
    expect(instrumental).not.toHaveProperty("gender");
    expect(instrumental).not.toHaveProperty("lyrics");
    expect(String(instrumental.prompt)).not.toMatch(/\bmale vocal\b|\bbaritone\b|\bfemale vocal\b/i);
  });

  it("aborts a blank vocal or instrumental request before fetch", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const lyricsRequired = { error: "Generation blocked: Lyrics are required." };
    const blocked = { error: "Generation blocked: No style or lyrics received by backend." };

    const vocal = await POST(generateRequest({ prompt: "   ", lyrics: "  ", lyricsText: "", text: "" }));
    expect(vocal.status).toBe(400);
    await expect(vocal.json()).resolves.toEqual(lyricsRequired);
    expect(JSON.stringify(lyricsRequired)).not.toMatch(/wavespeed/i);

    const styleOnly = await POST(
      generateRequest({ prompt: "piano, 90 BPM", lyrics: "   ", duration: 240, seed: 1, title: "Neon rain" }),
    );
    expect(styleOnly.status).toBe(400);
    await expect(styleOnly.json()).resolves.toEqual(lyricsRequired);

    const instrumental = await POST(generateRequest({ isInstrumental: true, prompt: " ", lyrics: "still here" }));
    expect(instrumental.status).toBe(400);
    await expect(instrumental.json()).resolves.toEqual(blocked);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((call) => String((call as [string, RequestInit?])[0]).includes("/v1/mureka"))).toBe(false);
  });

  it("accepts stylePrompt and lyricsText aliases and never sends an empty prompt", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: { id: "task-alias" } }));
    vi.stubGlobal("fetch", fetchMock);

    const aliased = await POST(
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stylePrompt: "Close piano, 80 BPM",
          lyricsText: "[Chorus]\nhey",
          gender: "female",
        }),
      }),
    );
    expect(aliased.status).toBe(200);
    const [aliasUrl, aliasInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(aliasUrl).toBe(SONG_URL);
    expect(aliasUrl).not.toContain("/v1/mureka");
    const aliasBody = JSON.parse(String(aliasInit.body)) as Record<string, unknown>;
    expect(aliasBody.prompt).toContain("Close piano, 80 BPM");
    expect(aliasBody.prompt).not.toBe("");
    expect(aliasBody.lyrics).toContain("[Chorus]");
    expect(aliasBody.lyrics).toContain("hey");
    expect(aliasBody).not.toHaveProperty("webhook");
    expect(aliasUrl).not.toMatch(/localhost|127\.0\.0\.1/);
    expectLockedPayload(aliasBody, {
      prompt: `${FEMALE_VOCAL_LEAD}Close piano, 80 BPM`,
      lyrics: "[Chorus]\nhey",
      gender: "female",
      output_format: "wav",
    });

    fetchMock.mockClear();
    const lyricsOnly = await POST(
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lyrics: "[Verse]\nstorm", gender: "male" }),
      }),
    );
    expect(lyricsOnly.status).toBe(200);
    const [songUrl, songInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(songUrl).toBe("https://api.wavespeed.ai/api/v3/mureka-ai/mureka-v9.5/generate-song");
    expect(songUrl).not.toContain("/v1/mureka");
    const songBody = JSON.parse(String(songInit.body)) as Record<string, unknown>;
    expect(songBody).not.toHaveProperty("prompt");
    expect(songBody.lyrics).toContain("[Verse]");
    expect(songBody.lyrics).toContain("storm");
    expect(songBody.gender).toBe("male");
    expectLockedPayload(songBody, {
      lyrics: "[Verse]\nstorm",
      gender: "male",
      output_format: "wav",
    });

    fetchMock.mockClear();
    const fromText = await POST(
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "[Bridge]\nfrom text", gender: "female" }),
      }),
    );
    expect(fromText.status).toBe(200);
    const textBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expect(textBody).not.toHaveProperty("prompt");
    expect(textBody.lyrics).toContain("from text");
    expect(textBody.gender).toBe("female");
  });

  it("does not call generate-song without lyrics and ignores duration and seed", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === BGM_URL) return jsonResponse({ data: { id: "task-bgm" } });
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const omitted = await POST(generateRequest({ lyrics: "   ", duration: 240, seed: 7, title: "Neon rain" }));
    expect(omitted.status).toBe(400);
    await expect(omitted.json()).resolves.toEqual({
      error: "Generation blocked: Lyrics are required.",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const kept = await POST(generateRequest({ duration: 240, seed: 7, title: "Neon rain" }));
    expect(kept.status).toBe(502);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<
      string,
      unknown
    >;
    expectLockedPayload(body, {
      prompt: `${MALE_VOCAL_LEAD}${DEFAULT_STYLE}`,
      lyrics: "[Verse]\nline\n[inst-short]",
      title: "Neon rain",
      output_format: "wav",
    });
    expect(body).not.toHaveProperty("duration");
    expect(body).not.toHaveProperty("seed");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(SONG_URL);
  });

  it("logs the completed task and downloads output.audio_url before the job is ready", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(" "));
    });
    const audio = "https://cdn.example/from-output.wav";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === SONG_URL) return jsonResponse({ data: { id: "task-shape" } });
      if (String(url).endsWith("/result")) {
        return jsonResponse({
          status: "completed",
          output: { audio_url: audio },
          result: { audio_url: "https://cdn.example/not-first.wav" },
        });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const accepted = await POST(generateRequest({ title: "Shape" }));
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({ status: "pending", taskId: "task-shape" });

    await settleTrackFromWaveSpeed("task-shape");

    expect(logs.some((line) => line.includes("[generate] completed task full payload:"))).toBe(true);
    expect(logs.some((line) => line.includes("[vault] uploading https://cdn.example/from-output.wav"))).toBe(true);
    expect(fetchMock.mock.calls.some((call) => call[0] === audio)).toBe(true);
    expect(readTrackJob("task-shape")?.status).toBe("failed");

    resetTrackJobs();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: "task-empty" } });
        return jsonResponse({ data: { status: "completed", outputs: [] } });
      }),
    );
    const queued = await POST(generateRequest({ title: "Empty" }));
    expect(queued.status).toBe(200);
    await expect(settleTrackFromWaveSpeed("task-empty")).rejects.toThrow(/no audio URL found/);
    expect(readTrackJob("task-empty")?.status).toBe("processing");
  });

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

  it("commits a vaulted_tracks row when the completed job has a userId", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(" "));
    });
    const wav = silentWav();
    const audio = "https://cdn.example/vaulted.wav";
    const taskId = "task-vault-user";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: taskId } });
        if (url === audio) {
          const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
          return new Response(copy, { status: 200 });
        }
        return jsonResponse({
          data: { status: "completed", outputs: [audio] },
        });
      }),
    );

    const accepted = await POST(
      generateRequest({ title: "Glass Harbor", userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    );
    expect(accepted.status).toBe(200);
    expect(readTrackJob(taskId)?.userId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    await settleTrackFromWaveSpeed(taskId);

    const wavUrl = `https://project.supabase.co/storage/v1/object/public/audio-vault/masters/${taskId}.wav`;
    const mp3Url = `https://project.supabase.co/storage/v1/object/public/audio-vault/masters/${taskId}.mp3`;
    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toEqual({
      user_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      title: "Glass Harbor",
      prompt: expect.any(String),
      lyrics: expect.any(String),
      vocal_id_used: null,
      wav_url: wavUrl,
      mp3_url: mp3Url,
      task_id: taskId,
    });
    expect(row).not.toHaveProperty("status");
    expect(row).not.toHaveProperty("master_url");
    expect(row).not.toHaveProperty("audio_url");
    expect(logs.some((line) => line === `[vault] DB row committed for task ${taskId}`)).toBe(true);
    const committedAt = logs.findIndex((line) => line.includes("[vault] DB row committed for task"));
    const storedAt = logs.findIndex((line) => line.includes(`[vault] stored ${taskId}`));
    expect(storedAt).toBeGreaterThan(committedAt);
    expect(readTrackJob(taskId)).toMatchObject({ status: "completed", wavUrl, mp3Url });
  });

  it("does not commit a vault row or log success when userId is empty", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    const logs: string[] = [];
    const errors: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map((part) => String(part)).join(" "));
    });
    const wav = silentWav();
    const audio = "https://cdn.example/orphan.wav";
    const taskId = "task-vault-empty";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === SONG_URL) return jsonResponse({ data: { id: taskId } });
        if (url === audio) {
          const copy = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
          return new Response(copy, { status: 200 });
        }
        return jsonResponse({
          data: { status: "completed", outputs: [audio] },
        });
      }),
    );

    const accepted = await POST(generateRequest({ title: "No Owner" }));
    expect(accepted.status).toBe(200);
    expect(readTrackJob(taskId)?.userId).toBe("");

    await settleTrackFromWaveSpeed(taskId);

    expect(uploadMock).toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("[vault] DB row committed for task"))).toBe(false);
    expect(logs.some((line) => line.includes("[vault] stored"))).toBe(false);
    expect(errors.some((line) => line.includes("DB row skipped because userId was empty"))).toBe(true);
    expect(readTrackJob(taskId)?.status).toBe("failed");
    expect(readTrackJob(taskId)?.error).toMatch(/userId was empty/);
    expect(readTrackJob(taskId)?.wavUrl).toBeUndefined();
    expect(readTrackJob(taskId)?.mp3Url).toBeUndefined();
  });

  it("routes instrumental masters to generate-bgm without lyrics or title", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === BGM_URL) return jsonResponse({ data: { id: "task-bgm" } });
      return jsonResponse({ data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const instrumental = await POST(
      new Request("http://localhost/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          isInstrumental: true,
          prompt: "Heavy southern rock, 74 BPM",
          duration: 180,
          seed: 4,
          title: "Beat only",
        }),
      }),
    );
    expect(instrumental.status).toBe(200);
    const [bgmUrl, bgmInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(bgmUrl).toBe(BGM_URL);
    expect(bgmUrl).not.toContain("/v1/mureka");
    expectLockedPayload(JSON.parse(String(bgmInit.body)) as Record<string, unknown>, {
      prompt: "Heavy southern rock, 74 BPM",
      output_format: "wav",
    });
  });
});
