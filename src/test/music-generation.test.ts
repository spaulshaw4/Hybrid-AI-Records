import { afterEach, describe, expect, it, vi } from "vitest";
import { generateStudioTrack, SONIC_CREATE_URL } from "@/lib/music-generation";

describe("generateStudioTrack", () => {
  const originalKey = process.env.MUSIC_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MUSIC_API_KEY;
    else process.env.MUSIC_API_KEY = originalKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs a Suno 5.5 custom-mode body with lyrics in prompt and style in tags", async () => {
    process.env.MUSIC_API_KEY = "test-music-key";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ message: "success", task_id: "task-55" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

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
    expect(started.payload.mv).toBe("sonic-v5-5");
    expect(started.payload.prompt).toBe("[Verse 1]\nNight drive");
    expect(started.payload.tags).toBe(
      "Nu-Metal, Rap Rock, 102 BPM, distorted guitars, 808s, Authentic lead",
    );
    expect(started.payload.vocal_gender).toBe("m");
    expect(started.payload.negative_tags).toContain("female vocals");
    expect(started.payload.make_instrumental).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(SONIC_CREATE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-music-key");
    expect(log).toHaveBeenCalledWith(
      "[SUNO_5_5_DISPATCH_BODY]",
      expect.stringContaining('"mv": "sonic-v5-5"'),
    );
  });

  it("uses female vocal gender and the female negative tag set", async () => {
    process.env.MUSIC_API_KEY = "test-music-key";
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ task_id: "task-f" }), { status: 200 }),
      ),
    );

    const started = await generateStudioTrack({
      genre: "Pop",
      vocalGender: "Female",
      lyrics: "[Chorus]\nGo",
    });
    expect(started.payload.vocal_gender).toBe("f");
    expect(started.payload.negative_tags).toContain("male vocals");
    expect(started.payload.tags).toContain("raw acoustic studio recording");
  });
});
