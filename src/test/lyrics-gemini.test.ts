import { afterEach, describe, expect, it, vi } from "vitest";

const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    constructor(_opts?: { apiKey?: string }) {}
    models = { generateContent: generateContentMock };
  },
}));

import { COPRODUCER_GEMINI_MODEL, writeLyrics } from "@/lib/lyrics.server";

describe("Co-Producer Gemini lyrics via @google/genai", () => {
  const originalKey = process.env.GEMINI_API_KEY;
  const originalGoogleKey = process.env.GOOGLE_API_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (originalGoogleKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalGoogleKey;
    vi.clearAllMocks();
  });

  it("runs gemini-2.5-flash and returns response.text", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    generateContentMock.mockResolvedValue({ text: "[Verse 1]\nGo\n[Chorus]\nHold the line" });

    const lyrics = await writeLyrics({
      concept: "night drive",
      title: "Night Drive",
      style: "Nu-Metal",
      language: "Lithuanian (Lietuvių)",
    });

    expect(lyrics).toContain("[Verse 1]");
    expect(lyrics).toContain("[Chorus]\nHold the line");
    expect(COPRODUCER_GEMINI_MODEL).toBe("gemini-2.5-flash");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
    const [params] = generateContentMock.mock.calls[0] as [
      { model: string; contents: string; config?: { maxOutputTokens: number } },
    ];
    expect(params.model).toBe("gemini-2.5-flash");
    expect(params.contents).toContain("Write complete song lyrics");
    expect(params.contents).toContain("[Verse]");
    expect(params.contents).toContain("[Chorus]");
    expect(params.contents).toContain("[Bridge]");
    expect(params.contents).toContain("[Outro]");
    expect(params.contents).toContain("Lithuanian (Lietuvių)");
    expect(params.contents).toContain("Night Drive");
  });

  it("throws when GEMINI_API_KEY is missing on the server", async () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      writeLyrics({
        concept: "night drive",
        title: "Night Drive",
        language: "English",
      }),
    ).rejects.toThrow("Missing GEMINI_API_KEY in .env.local");
    expect(logged).toHaveBeenCalledWith(
      "[GEMINI_DIRECT_ERROR]",
      "GEMINI_API_KEY is undefined — add it to .env.local",
    );
    logged.mockRestore();
  });

  it("logs GEMINI_DIRECT_ERROR and does not fall back when Gemini fails", async () => {
    process.env.GEMINI_API_KEY = "test-gemini-key";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    generateContentMock.mockRejectedValue(new Error("quota exceeded"));

    await expect(
      writeLyrics({
        concept: "night drive",
        title: "Night Drive",
        language: "English",
      }),
    ).rejects.toThrow("quota exceeded");

    expect(logged).toHaveBeenCalledWith("[GEMINI_DIRECT_ERROR]", expect.any(Error));
    logged.mockRestore();
  });
});
