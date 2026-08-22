import { afterEach, describe, expect, it, vi } from "vitest";

const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));

vi.mock("replicate", () => ({
  default: class Replicate {
    constructor(_opts?: { auth?: string }) {}
    run = (...args: unknown[]) => runMock(...args);
  },
}));

import { COPRODUCER_GEMINI_MODEL, writeLyrics } from "@/lib/lyrics.server";

describe("Co-Producer Gemini lyrics via Replicate", () => {
  const originalToken = process.env.REPLICATE_API_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
    vi.clearAllMocks();
  });

  it("runs google/gemini-2.5-flash and joins an output array", async () => {
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    runMock.mockResolvedValue(["[Verse 1]\nGo\n", "[Chorus]\nHold the line"]);

    const lyrics = await writeLyrics({
      concept: "night drive",
      title: "Night Drive",
      style: "Nu-Metal",
      language: "Lithuanian (Lietuvių)",
    });

    expect(lyrics).toContain("[Verse 1]");
    expect(lyrics).toContain("[Chorus]\nHold the line");
    expect(COPRODUCER_GEMINI_MODEL).toBe(
      process.env.REPLICATE_GEMINI_MODEL?.trim() || "google/gemini-2.5-flash",
    );
    expect(COPRODUCER_GEMINI_MODEL).not.toMatch(/llama/i);
    expect(runMock).toHaveBeenCalledTimes(1);
    const [model, options] = runMock.mock.calls[0] as [
      string,
      { input: { prompt: string; temperature: number; max_output_tokens: number } },
    ];
    expect(model).toBe(COPRODUCER_GEMINI_MODEL);
    expect(model).not.toMatch(/llama/i);
    expect(options.input.temperature).toBe(0.75);
    expect(options.input.max_output_tokens).toBe(2048);
    expect(options.input.prompt).toContain("elite music co-producer");
    expect(options.input.prompt).toContain("Lithuanian (Lietuvių)");
    expect(options.input.prompt).toContain("Night Drive");
    expect(options.input.prompt).toContain("Nu-Metal");
  });

  it("logs GEMINI_REPLICATE_ERROR and does not fall back when Replicate fails", async () => {
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runMock.mockRejectedValue(new Error("model not found"));

    await expect(
      writeLyrics({
        concept: "night drive",
        title: "Night Drive",
        language: "English",
      }),
    ).rejects.toThrow("model not found");

    expect(logged).toHaveBeenCalledWith("[GEMINI_REPLICATE_ERROR]", expect.any(Error));
    logged.mockRestore();
  });
});
