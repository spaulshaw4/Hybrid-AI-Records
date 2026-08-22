import { afterEach, describe, expect, it, vi } from "vitest";

const { createInteractionMock } = vi.hoisted(() => ({ createInteractionMock: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(_opts?: { apiKey?: string }) {}
    interactions = { create: createInteractionMock };
  },
}));

import { COPRODUCER_GEMINI_MODEL, writeLyricsWithStudio } from "@/lib/coproducer";
import { writeLyrics } from "@/lib/lyrics.server";

describe("Co-Producer Google Interactions API", () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
    vi.clearAllMocks();
  });

  it("creates a gemini-3.7-flash interaction and returns output_text", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    createInteractionMock.mockResolvedValue({
      output_text: "[Verse 1]\nGo\n[Chorus]\nHold the line",
    });

    const result = await writeLyricsWithStudio("Night Drive", "Lithuanian (Lietuvių)");

    expect(result.lyrics).toContain("[Verse 1]");
    expect(result.lyrics).toContain("[Chorus]\nHold the line");
    expect(COPRODUCER_GEMINI_MODEL).toBe("gemini-3.7-flash");
    expect(createInteractionMock).toHaveBeenCalledTimes(1);
    const [params] = createInteractionMock.mock.calls[0] as [{ model: string; input: string }];
    expect(params.model).toBe("gemini-3.7-flash");
    expect(params.input).toBe(
      'You are an elite music co-producer. Write complete song lyrics in Lithuanian (Lietuvių) with section markers ([Verse], [Chorus], [Bridge], [Outro]) for a track titled "Night Drive". Return only the lyrics.',
    );
  });

  it("throws when GEMINI_API_KEY is missing on the server", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    await expect(writeLyricsWithStudio("Night Drive", "English")).rejects.toThrow(
      "GEMINI_API_KEY is not defined in .env.local",
    );
  });

  it("logs STUDIO_INTERACTIONS_ERROR and rethrows", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createInteractionMock.mockRejectedValue(new Error("quota exceeded"));

    await expect(writeLyricsWithStudio("Night Drive", "English")).rejects.toThrow("quota exceeded");
    expect(logged).toHaveBeenCalledWith("[STUDIO_INTERACTIONS_ERROR]", expect.any(Error));
    logged.mockRestore();
  });

  it("writeLyrics still returns the lyric string for engine callers", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    createInteractionMock.mockResolvedValue({ output_text: "[Chorus]\nGo" });
    await expect(
      writeLyrics({ concept: "night drive", title: "Night Drive", language: "English" }),
    ).resolves.toBe("[Chorus]\nGo");
  });
});
