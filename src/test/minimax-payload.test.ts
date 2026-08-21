import { describe, it, expect } from "vitest";
import { buildMiniMaxPayload } from "@/lib/minimax-payload";

describe("buildMiniMaxPayload", () => {
  it("builds a Replicate-compatible vocal payload with language directive", () => {
    const result = buildMiniMaxPayload({
      prompt: "Alternative rock, master audio quality",
      lyrics: "[Verse 1]\nLietuvos dangus šiandien mūsų",
      language: "lt",
      audioFormat: "mp3",
    });

    expect(result.input).toMatchObject({
      is_instrumental: false,
      lyrics_optimizer: true,
      audio_format: "mp3",
      lyrics: "[Verse 1]\nLietuvos dangus šiandien mūsų",
    });

    expect(result.input.prompt).toContain("Alternative rock, master audio quality");
    expect(result.input.prompt).toContain("Lithuanian");
    expect(result.input.prompt).toContain("pronounce č as 'ch'");
    expect(result.settings).toMatchObject({
      sample_rate: 44100,
      bitrate: 256000,
      instrumental: false,
      timeout_seconds: 240,
    });
  });

  it("omits lyrics and uses the no-vocals directive for instrumentals", () => {
    const result = buildMiniMaxPayload({
      prompt: "Dark cinematic instrumental",
      lyrics: "some words",
      language: "lt",
      instrumental: true,
      audioFormat: "wav",
    });

    expect(result.input.is_instrumental).toBe(true);
    expect(result.input.lyrics).toBeUndefined();
    expect(result.input.prompt).toContain("Instrumental only");
    expect(result.input.prompt).not.toContain("Vocal delivery:");
    expect(result.input.audio_format).toBe("wav");
  });

  it("keeps the prompt under the 6000-character budget", () => {
    const hugePrompt = "x".repeat(6500);
    const result = buildMiniMaxPayload({
      prompt: hugePrompt,
      lyrics: "small lyrics",
      language: "lt",
    });

    expect(result.input.prompt.length).toBeLessThanOrEqual(6000);
  });

  it("normalizes Unicode in lyrics before sending", () => {
    // Combining-mark form of ą (a + combining ogonek) should be composed to NFC.
    const result = buildMiniMaxPayload({
      prompt: "Rock",
      lyrics: "a\u0328", // a + combining ogonek
      language: "lt",
    });

    expect(result.input.lyrics).toBe("ą");
  });

  it("uses a custom language when provided", () => {
    const result = buildMiniMaxPayload({
      prompt: "Heavy rock",
      lyrics: "text",
      language: "custom",
      customLanguage: "Latvian",
    });

    expect(result.input.prompt).toContain("Latvian");
  });
});
