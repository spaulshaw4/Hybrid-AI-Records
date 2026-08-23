import { afterEach, describe, expect, it, vi } from "vitest";

const { replicateGeminiFlashLyricsMock } = vi.hoisted(() => ({
  replicateGeminiFlashLyricsMock: vi.fn(),
}));

vi.mock("@/lib/replicate-llm.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/replicate-llm.server")>(
    "@/lib/replicate-llm.server",
  );
  return {
    ...actual,
    replicateGeminiFlashLyrics: replicateGeminiFlashLyricsMock,
  };
});

import {
  COPRODUCER_REPLICATE_MODEL,
  LYRIC_ENGINE_TIMEOUT_MS,
  writeLyricsWithStudio,
} from "@/lib/coproducer";
import { joinReplicateOutput } from "@/lib/replicate-llm.server";
import { writeLyrics } from "@/lib/lyrics.server";

const KEYS = ["LYRIC_ENGINE_API_KEY", "ENGINE_API_KEY", "REPLICATE_API_KEY", "REPLICATE_API_TOKEN"] as const;

describe("Co-Producer Gemini 2.5 Flash on Replicate", () => {
  const original = Object.fromEntries(KEYS.map((name) => [name, process.env[name]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    for (const name of KEYS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sends the lyric prompt and system instruction to Gemini Flash", async () => {
    process.env.REPLICATE_API_KEY = "test-replicate-key";
    replicateGeminiFlashLyricsMock.mockResolvedValue("[Verse 1]\nGo\n[Chorus]\nHold the line");

    const result = await writeLyricsWithStudio("Night Drive", "Lithuanian (Lietuvių)");

    expect(result).toEqual({ lyrics: "[Verse 1]\nGo\n[Chorus]\nHold the line" });
    expect(COPRODUCER_REPLICATE_MODEL).toBe("google/gemini-2.5-flash");
    expect(replicateGeminiFlashLyricsMock).toHaveBeenCalledTimes(1);
    const [input] = replicateGeminiFlashLyricsMock.mock.calls[0] as [
      { prompt: string; systemInstruction: string; timeoutMs: number },
    ];
    expect(input.timeoutMs).toBe(LYRIC_ENGINE_TIMEOUT_MS);
    expect(input.systemInstruction).toContain("section markers");
    expect(input.prompt).toContain("Night Drive");
    expect(input.prompt).toContain("Lithuanian (Lietuvių)");
  });

  it("joins stream, array, and string Replicate outputs", () => {
    expect(joinReplicateOutput(["[Verse]\n", "Go"])).toBe("[Verse]\nGo");
    expect(joinReplicateOutput("[Chorus]\nHold")).toBe("[Chorus]\nHold");
    expect(joinReplicateOutput({ text: "[Outro]\nFade" })).toBe("[Outro]\nFade");
  });

  it("throws when the lyric engine key is missing", async () => {
    for (const name of KEYS) delete process.env[name];
    await expect(writeLyricsWithStudio("Night Drive", "English")).rejects.toThrow(
      "The Co-Producer is not configured. Add the lyric engine API key to .env.local.",
    );
  });

  it("does not leak vendor errors to the caller", async () => {
    process.env.REPLICATE_API_KEY = "test-replicate-key";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    replicateGeminiFlashLyricsMock.mockRejectedValue(new Error("Replicate 429 quota exceeded"));

    await expect(writeLyricsWithStudio("Night Drive", "English")).rejects.toThrow(
      "The Co-Producer could not write lyrics. Please try again.",
    );
    expect(logged).toHaveBeenCalledWith("[LYRIC_ENGINE_ERROR]", expect.any(Error));
    logged.mockRestore();
  });

  it("fails fast when the lyric engine does not respond", async () => {
    vi.useFakeTimers();
    process.env.REPLICATE_API_KEY = "test-replicate-key";
    replicateGeminiFlashLyricsMock.mockReturnValue(new Promise(() => {}));

    const pending = writeLyricsWithStudio("Night Drive", "English");
    const expectation = expect(pending).rejects.toThrow("Lyric engine timed out");
    await vi.advanceTimersByTimeAsync(LYRIC_ENGINE_TIMEOUT_MS);
    await expectation;
  });

  it("writeLyrics still returns the lyric string for engine callers", async () => {
    process.env.ENGINE_API_KEY = "test-engine-key";
    replicateGeminiFlashLyricsMock.mockResolvedValue("[Chorus]\nGo");
    await expect(
      writeLyrics({ concept: "night drive", title: "Night Drive", language: "English" }),
    ).resolves.toBe("[Chorus]\nGo");
  });
});
