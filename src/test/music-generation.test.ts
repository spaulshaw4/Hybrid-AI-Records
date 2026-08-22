import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AIMUSICAPI_HEADER_FORMAT,
  generateStudioTrack,
  musicApiKey,
  SONIC_CREATE_URL,
  SONIC_TASK_URL,
  waitForStudioTrack,
} from "@/lib/music-generation";

const KEY_NAMES = [
  "AIMUSICAPI_KEY",
  "MUSIC_API_KEY",
  "VITE_MUSIC_API_KEY",
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
    expect(started.payload.task_type).toBe("create_music");
    expect(started.payload.custom_mode).toBe(true);
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload.prompt).toBe("[Verse 1]\nNight drive");
    expect(started.payload.tags).toBe(
      "Nu-Metal, Rap Rock, 102 BPM, distorted guitars, 808s, Authentic lead",
    );
    expect(started.payload.title).toBe("Night Drive");
    expect(started.payload.vocal_gender).toBe("m");
    expect(started.payload.negative_tags).toContain("female vocals");
    expect(started.payload.make_instrumental).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SONIC_CREATE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-music-key");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.task_type).toBe("create_music");
    expect(body.mv).toBe("sonic-v5");
    expect(body.vocal_gender).toBe("m");
    expect(Object.values(body).every((value) => value !== undefined && value !== null)).toBe(true);
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Target URL:", SONIC_CREATE_URL);
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Using key prefix:", "test-mus...");
    expect(log).toHaveBeenCalledWith("[AIMUSICAPI] Header format:", AIMUSICAPI_HEADER_FORMAT);
    expect(log).toHaveBeenCalledWith(
      "[MUSICAPI_CREATE_REQUEST]",
      expect.stringContaining('"task_type": "create_music"'),
    );
    expect(log).toHaveBeenCalledWith(
      "[MUSICAPI_CREATE_RESPONSE]",
      200,
      expect.stringContaining('"task_id": "task-55"'),
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
      "[AIMUSICAPI] AIMUSICAPI_KEY / AI_MUSIC_API_KEY / MUSIC_API_KEY / ENGINE_API_KEY is undefined — add it to .env.local",
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
    expect(started.payload.negative_tags).toContain("male vocals");
    expect(started.payload.tags).toContain("raw acoustic studio recording");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body.mv).toBe("sonic-v5");
    expect(body.vocal_gender).toBe("f");
  });

  it("omits vocal_gender when no gender is selected", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-no-gender");

    const started = await generateStudioTrack({ genre: "Pop", lyrics: "[Chorus]\nGo" });
    expect(started.payload.mv).toBe("sonic-v5");
    expect(started.payload).not.toHaveProperty("vocal_gender");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("vocal_gender");
  });

  it("omits vocal_gender when the model does not support it", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = await stubCreateOk("task-legacy-mv");

    const started = await generateStudioTrack({
      genre: "Pop",
      vocalGender: "Male",
      lyrics: "[Chorus]\nGo",
      mv: "sonic-v4",
    });
    expect(started.payload.mv).toBe("sonic-v4");
    expect(started.payload).not.toHaveProperty("vocal_gender");
    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("vocal_gender");
  });

  it("polls GET /sonic/task/:id every 4s until data.status is succeeded", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const running = { data: { status: "running" } };
    const succeeded = {
      data: { status: "succeeded", audio_url: "https://cdn.example/track.mp3", title: "Studio Master" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(running))
      .mockResolvedValueOnce(jsonResponse(succeeded));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();

    const pending = waitForStudioTrack("task-poll");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    const finished = await pending;

    expect(finished.status).toBe("completed");
    expect(finished.audioUrl).toBe("https://cdn.example/track.mp3");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${SONIC_TASK_URL}/task-poll`);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual({
      Authorization: "Bearer test-music-key",
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
  });

  it("returns data.output when succeeded and audio_url is missing", async () => {
    clearMusicKeys();
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ data: { status: "succeeded", output: "https://cdn.example/out.mp3" } }),
      ),
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
});
