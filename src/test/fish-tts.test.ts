import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/apiframe.server", () => ({
  archiveGeneratedAudioBytes: vi.fn(async () => "https://cdn.example/vocal.mp3"),
}));

import { convertVocalsWithStems, FISH_TTS_URL } from "@/lib/fish-tts.server";

describe("Fish Audio native TTS", () => {
  const originalFish = process.env.FISH_API_KEY;
  const originalAudio = process.env.FISH_AUDIO_API_KEY;

  afterEach(() => {
    if (originalFish === undefined) delete process.env.FISH_API_KEY;
    else process.env.FISH_API_KEY = originalFish;
    if (originalAudio === undefined) delete process.env.FISH_AUDIO_API_KEY;
    else process.env.FISH_AUDIO_API_KEY = originalAudio;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("POSTs Bearer auth to https://api.fish.audio/v1/tts", async () => {
    delete process.env.FISH_AUDIO_API_KEY;
    process.env.FISH_API_KEY = "  fish-test-key  ";
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await convertVocalsWithStems({
      lyrics: "[Chorus]\nHold the line",
      userId: "user-1",
      taskId: "task-fish",
      title: "Vocal stem",
    });

    expect(FISH_TTS_URL).toBe("https://api.fish.audio/v1/tts");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fish-test-key");
    expect(headers["Content-Type"]).toBe("application/msgpack");
    expect(result.tracks[0]?.audioUrl).toBe("https://cdn.example/vocal.mp3");
  });

  it("throws instead of falling back when the Fish key is missing", async () => {
    delete process.env.FISH_API_KEY;
    delete process.env.FISH_AUDIO_API_KEY;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      convertVocalsWithStems({
        lyrics: "[Chorus]\nHold the line",
        userId: "user-1",
        taskId: "task-fish",
      }),
    ).rejects.toThrow("Missing FISH_API_KEY in .env.local");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(
      "[FISH_AUDIO] FISH_API_KEY / FISH_AUDIO_API_KEY is undefined — add it to .env.local",
    );
  });
});
