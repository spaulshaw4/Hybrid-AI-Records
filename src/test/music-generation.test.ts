import { afterEach, describe, expect, it, vi } from "vitest";
import { resetPipelineBreakers } from "@/lib/pipeline-breaker";
import {
  AIMUSICAPI_HEADER_FORMAT,
  AIMUSICAPI_MODEL,
  extractAudioUrl,
  generateStudioTrack,
  MUSICAPI_CREATE_URL,
  musicApiKey,
  SONIC_CREATE_URL,
  SONIC_TASK_URL,
  waitForStudioTrack,
  POLLING_INTERVAL_MS,
} from "@/lib/music-generation";

const KEY_NAMES = [
  "AIMUSICAPI_KEY",
  "MUSIC_API_KEY",
  "VITE_MUSIC_API_KEY",
  "VITE_AIMUSICAPI_KEY",
  "VITE_MUSICAPI_KEY",
  "MUSICAPI_KEY",
  "SONIC_API_KEY",
  "AIMUSIC_API_KEY",
  "AI_MUSIC_API_KEY",
  "ENGINE_API_KEY",
] as const;

describe("MusicAPI sonic workflow", () => {
  const originalKeys: Record<(typeof KEY_NAMES)[number], string | undefined> = {
    AIMUSICAPI_KEY: process.env.AIMUSICAPI_KEY,
    MUSIC_API_KEY: process.env.MUSIC_API_KEY,
    VITE_MUSIC_API_KEY: process.env.VITE_MUSIC_API_KEY,
    VITE_AIMUSICAPI_KEY: process.env.VITE_AIMUSICAPI_KEY,
    VITE_MUSICAPI_KEY: process.env.VITE_MUSICAPI_KEY,
    MUSICAPI_KEY: process.env.MUSICAPI_KEY,
    SONIC_API_KEY: process.env.SONIC_API_KEY,
    AIMUSIC_API_KEY: process.env.AIMUSIC_API_KEY,
    AI_MUSIC_API_KEY: process.env.AI_MUSIC_API_KEY,
    ENGINE_API_KEY: process.env.ENGINE_API_KEY,
  };

  afterEach(() => {
    for (const name of KEY_NAMES) {
      if (originalKeys[name] === undefined) delete process.env[name];
      else process.env[name] = originalKeys[name];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetPipelineBreakers();
  });

  function clearMusicKeys() {
    for (const name of KEY_NAMES) delete process.env[name];
  }

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async function stubCreateOk(taskId = "task-55") {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "success", task_id: taskId }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends sonic-v5 when the request falls back to the MusicAPI host", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith(SONIC_CREATE_URL)
        ? jsonResponse({ error: "not found" }, 404)
        : jsonResponse({ message: "success", task_id: "task-fallback" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateStudioTrack({
      genre: "Pop",
      vocalGender: "Male",
      lyrics: "[Chorus]\nGo",
    });

    const [primaryUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [fallbackUrl, fallbackInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(primaryUrl).toBe(SONIC_CREATE_URL);
    expect(fallbackUrl).toBe(MUSICAPI_CREATE_URL);
    const primaryBody = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(primaryBody.mv).toBe(AIMUSICAPI_MODEL);
    const fallbackBody = JSON.parse(String(fallbackInit.body)) as Record<string, unknown>;
    expect(fallbackBody.mv).toBe("sonic-v5");
    expect(fallbackBody.vocal_gender).toBe("m");
  });

  it("normalizes studio slider weights to the 0-1 range Sonic accepts", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-weights");

    await generateStudioTrack({
      genre: "Pop",
      lyrics: "[Chorus]\nGo",
      styleInfluence: 76,
      audioInfluence: 82,
      weirdness: 20,
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    // Sonic answers "should be a number between 0 and 1" for a raw 76.
    expect(body.style_weight).toBe(0.76);
    expect(body.audio_weight).toBe(0.82);
    expect(body.weirdness_constraint).toBe(0.2);
  });

  it("reads a slider of 1 as one percent, not as maximum", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-low-weight");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo", weirdness: 1 });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.weirdness_constraint).toBe(0.01);
  });

  it("omits weights the artist never set", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-no-weights");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("style_weight");
    expect(body).not.toHaveProperty("audio_weight");
    expect(body).not.toHaveProperty("weirdness_constraint");
  });

  it("keeps the artist's tempo in the tags even when tags are pre-built", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-tempo");

    // The studio always sends pre-built tags, which used to skip the BPM append.
    const started = await generateStudioTrack({
      genre: "Pop",
      lyrics: "[Chorus]\nGo",
      tags: "Acoustic, Country",
      bpm: 96,
    });

    expect(started.payload.tags).toBe("Acoustic, Country, 96 BPM, steady tempo");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.tags).toContain("96 BPM");
  });

  it("does not repeat a tempo the tags already carry", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await stubCreateOk("task-tempo-dupe");

    const started = await generateStudioTrack({
      genre: "Pop",
      lyrics: "[Chorus]\nGo",
      tags: "Acoustic, 120 BPM",
      bpm: 96,
    });

    expect(started.payload.tags).toBe("Acoustic, 120 BPM");
  });

  it("POSTs create_music with lyrics in prompt and style in tags", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk();

    const started = await generateStudioTrack({
      genre: "Nu-Metal",
      subGenre: "Rap Rock",
      bpm: 102,
      instruments: ["distorted guitars", "808s"],
      vocalTimbre: "Authentic lead",
      vocalGender: "Male",
      lyrics: "[Verse 1]\nNight drive",
      title: "Night Drive",
    });

    expect(started.taskId).toBe("task-55");
    expect(started.payload.custom_mode).toBe(true);
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload.prompt).toBe("[Verse 1]\nNight drive");
    expect(started.payload.tags).toBe(
      "Nu-Metal, Rap Rock, 102 BPM, steady tempo, distorted guitars, 808s, Authentic lead, male vocals",
    );
    expect(started.payload.title).toBe("Night Drive");
    expect(started.payload.vocal_gender).toBe("m");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SONIC_CREATE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-music-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.mv).toBe(AIMUSICAPI_MODEL);
    expect(body.custom_mode).toBe(true);
    expect(body.vocal_gender).toBe("m");
    expect(body).not.toHaveProperty("customMode");
    expect(body).not.toHaveProperty("model");
    expect(Object.values(body).every((value) => value !== undefined && value !== null)).toBe(true);
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Target URL:", SONIC_CREATE_URL);
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Using key prefix:", "test-mus...");
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Header format:", AIMUSICAPI_HEADER_FORMAT);
    expect(log).toHaveBeenCalledWith(
      "[EXACT_OUTBOUND_BODY]",
      expect.stringContaining(`"mv": "${AIMUSICAPI_MODEL}"`),
    );
    expect(log).toHaveBeenCalledWith(
      "[AIMUSICAPI_DISPATCH]",
      expect.stringContaining(`"mv": "${AIMUSICAPI_MODEL}"`),
    );
    expect(log).toHaveBeenCalledWith("[MUSICAPI_DISPATCH]", {
      url: SONIC_CREATE_URL,
      status: 200,
      attempt: 1,
    });
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI_RESPONSE_STATUS]", 200);
    expect(log).toHaveBeenCalledWith(
      "[AIMUSICAPI_RESPONSE_BODY]",
      expect.stringContaining("task-55"),
    );
  });

  it("prefers AIMUSICAPI_KEY over MUSIC_API_KEY and ENGINE_API_KEY", async () => {
    clearMusicKeys();
    process.env.AIMUSICAPI_KEY = "primary-aimusicapi-key";
    process.env.MUSIC_API_KEY = "secondary-music-key";
    process.env.ENGINE_API_KEY = "engine-fallback-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-primary");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer primary-aimusicapi-key");
  });

  it("uses ENGINE_API_KEY when music-specific keys are unset", async () => {
    clearMusicKeys();
    process.env.ENGINE_API_KEY = "engine-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-engine");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer engine-music-key");
  });

  it("logs the full upstream body when create returns a non-200 status", async () => {
    clearMusicKeys();
    process.env.AIMUSICAPI_KEY = "diag-music-key";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ type: "unauthorized", error: "Invalid API key" }, 401),
      ),
    );

    await expect(generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" })).rejects.toThrow(
      "Music engine: Invalid API key",
    );
    expect(error).toHaveBeenCalledWith(
      "[AIMUSICAPI_ERROR]",
      401,
      expect.stringContaining("Invalid API key"),
    );
  });

  it("defaults the title to Studio Master", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await stubCreateOk();
    const started = await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    expect(started.payload.title).toBe("Studio Master");
  });

  it("uses MUSICAPI_KEY when MUSIC_API_KEY is unset", async () => {
    clearMusicKeys();
    process.env.MUSICAPI_KEY = "alias-musicapi-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-alias");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer alias-musicapi-key");
  });

  it("uses VITE_MUSIC_API_KEY when MUSIC_API_KEY is unset", async () => {
    clearMusicKeys();
    process.env.VITE_MUSIC_API_KEY = "vite-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-vite");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer vite-music-key");
  });

  it("uses SONIC_API_KEY when the other names are unset", async () => {
    clearMusicKeys();
    process.env.SONIC_API_KEY = "alias-sonic-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-sonic");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer alias-sonic-key");
  });

  it("uses AI_MUSIC_API_KEY when MUSIC_API_KEY is unset", async () => {
    clearMusicKeys();
    process.env.AI_MUSIC_API_KEY = "alias-aimusic-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-aimusic");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer alias-aimusic-key");
  });

  it("uses AIMUSIC_API_KEY when MUSIC_API_KEY is unset", async () => {
    clearMusicKeys();
    process.env.AIMUSIC_API_KEY = "alias-aimusic-direct";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-aimusic-direct");

    await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer alias-aimusic-direct");
  });

  it("logs PIPELINE_INIT_FAILED when no music API key is configured", () => {
    clearMusicKeys();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const message =
      "[PIPELINE_INIT_FAILED] MusicAPI (Base Arrangement) failed: Missing MUSIC_API_KEY";
    expect(() => musicApiKey()).toThrow(message);
    expect(error).toHaveBeenCalledWith(
      "[MUSICAPI] AIMUSICAPI_KEY / MUSICAPI_KEY / MUSIC_API_KEY is undefined — add it to .env.local (server), not only a VITE_ client key",
    );
    expect(error).toHaveBeenCalledWith(message);
  });

  it("uses female vocal gender and the female negative tag set", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => jsonResponse({ task_id: "task-f" }));
    vi.stubGlobal("fetch", fetchMock);

    const started = await generateStudioTrack({
      genre: "Pop",
      vocalGender: "Female",
      lyrics: "[Chorus]\nGo",
    });
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload.vocal_gender).toBe("f");
    expect(started.payload.tags).toContain("raw acoustic studio recording");
    expect(started.payload.tags).toContain("female vocals");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.mv).toBe(AIMUSICAPI_MODEL);
    expect(body.vocal_gender).toBe("f");
    expect(body.tags).toEqual(expect.stringContaining("female vocals"));
  });

  it("omits vocal_gender when no gender is selected", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-no-gender");

    const started = await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload).not.toHaveProperty("vocal_gender");
    expect(started.payload.tags).not.toContain("male vocals");
    expect(started.payload.tags).not.toContain("female vocals");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("vocal_gender");
  });

  it("ignores a legacy mv and sends the host's own model", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-locked-v5");

    const started = await generateStudioTrack({
      genre: "Pop",
      vocalGender: "Male",
      lyrics: "[Chorus]\nGo",
      mv: "sonic-v4",
    });
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload.vocal_gender).toBe("m");
    expect(started.payload.tags).toContain("male vocals");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.mv).toBe(AIMUSICAPI_MODEL);
    expect(body.vocal_gender).toBe("m");
    expect(body.tags).toEqual(expect.stringContaining("male vocals"));
    expect(log).toHaveBeenCalledWith(
      "[AIMUSICAPI_DISPATCH]",
      expect.stringContaining(`"mv": "${AIMUSICAPI_MODEL}"`),
    );
  });

  it("sends vocal_gender m on sonic-v5 when male is selected via vocal_gender", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-chirp");

    const started = await generateStudioTrack({
      genre: "Pop",
      vocal_gender: "male",
      lyrics: "[Chorus]\nGo",
      mv: "chirp-v5",
    });
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload.vocal_gender).toBe("m");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.vocal_gender).toBe("m");
    expect(body.mv).toBe(AIMUSICAPI_MODEL);
  });

  it("polls GET /sonic/task/:id until data.status is succeeded", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const running = { data: { status: "running" } };
    const succeeded = {
      data: { status: "succeeded", audio_url: "https://cdn.example/track.mp3", title: "Studio Master" },
    };
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (!url.includes("/sonic/task/")) {
        return new Response(null, { status: 200 });
      }
      polls += 1;
      return jsonResponse(polls === 1 ? running : succeeded);
    });
    vi.stubGlobal("fetch", fetchMock);

    const finished = await waitForStudioTrack("task-poll");

    expect(finished.status).toBe("completed");
    expect(finished.audioUrl).toBe("https://cdn.example/track.mp3");
    expect(finished.title).toBe("Studio Master");
    expect(finished.trackIds).toContain("task-poll");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/sonic/task/task-poll"))).toBe(
      true,
    );
    const taskCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes("/sonic/task/task-poll"),
    ) as unknown as [RequestInfo, RequestInit?] | undefined;
    expect(taskCall?.[1]?.headers).toEqual({
      Authorization: "Bearer test-music-key",
      "Content-Type": "application/json",
    });
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Target URL:", `${SONIC_TASK_URL}/task-poll`);
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Using key prefix:", "test-mus...");
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Header format:", AIMUSICAPI_HEADER_FORMAT);
    expect(log).toHaveBeenCalledWith(
      "[MUSICAPI_POLL_RESPONSE]",
      200,
      expect.stringContaining('"status": "running"'),
    );
    expect(log).toHaveBeenCalledWith(
      "[MUSICAPI_POLL_RESPONSE]",
      200,
      expect.stringContaining('"status": "succeeded"'),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/\[SONIC_V5_POLL\] Task: task-poll \| Status: running \| Elapsed: \d+s/),
    );
  }, 15_000);

  it("completes when one clip of a multi-clip task has succeeded", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // Sonic returns two clips that finish independently. The first staying at
    // processing must not hide the second one's finished audio.
    const mixed = {
      data: [
        {
          state: "processing",
          audio_url: "https://audiopipe.suno.ai/?item_id=still-rendering",
        },
        {
          state: "succeeded",
          audio_url: "https://musicapi-cdn.b-cdn.net/stems/done.mp3",
          title: "Studio Master",
          duration: 141,
        },
      ],
    };
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/sonic/task/") ? jsonResponse(mixed) : jsonResponse({ ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const finished = await waitForStudioTrack("task-multi");

    expect(finished.status).toBe("completed");
    expect(finished.audioUrl).toBe("https://musicapi-cdn.b-cdn.net/stems/done.mp3");
  });

  it("reads audio from stream_url and clips response shapes", () => {
    expect(extractAudioUrl({ stream_url: "https://cdn.example/stream.mp3" })).toBe(
      "https://cdn.example/stream.mp3",
    );
    expect(extractAudioUrl({ clips: [{ audio_url: "https://cdn.example/clip.mp3" }] })).toBe(
      "https://cdn.example/clip.mp3",
    );
    expect(extractAudioUrl({ data: [{ source_url: "https://cdn.example/source.mp3" }] })).toBe(
      "https://cdn.example/source.mp3",
    );
    expect(extractAudioUrl({ output: { audio_url: "https://cdn.example/out.mp3" } })).toBe(
      "https://cdn.example/out.mp3",
    );
    expect(extractAudioUrl({ data: [] })).toBeNull();
    expect(extractAudioUrl(null)).toBeNull();
  });

  it("retries transient 429/500 poll failures instead of aborting immediately", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (!url.includes("/sonic/task/")) {
        return new Response(null, { status: 200 });
      }
      polls += 1;
      if (polls === 1) return new Response("rate limited", { status: 429 });
      if (polls === 2) return new Response("server error", { status: 500 });
      return jsonResponse({
        data: {
          status: "succeeded",
          audio_url: "https://cdn.example/recovered.mp3",
          title: "Recovered",
          id: "clip-9",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = waitForStudioTrack("task-retry");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS);
    await Promise.resolve();
    const finished = await pending;

    expect(finished.audioUrl).toBe("https://cdn.example/recovered.mp3");
    expect(finished.title).toBe("Recovered");
    expect(finished.trackIds).toEqual(expect.arrayContaining(["task-retry", "clip-9"]));
    expect(warn).toHaveBeenCalled();
  });

  it("returns data.output when succeeded and audio_url is missing", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (!url.includes("/sonic/task/")) return new Response(null, { status: 200 });
        return jsonResponse({ data: { status: "succeeded", output: "https://cdn.example/out.mp3" } });
      }),
    );
    const finished = await waitForStudioTrack("task-output");
    expect(finished.audioUrl).toBe("https://cdn.example/out.mp3");
  });

  it("throws when data.status is failed", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { status: "failed" } })),
    );
    await expect(waitForStudioTrack("task-fail")).rejects.toThrow("Music engine: generation failed.");
  });

  it("aborts polling cleanly when the abort signal fires", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ data: { status: "running" } })),
    );
    const controller = new AbortController();
    const pending = waitForStudioTrack("task-abort", { abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("Render canceled");
  });
});
