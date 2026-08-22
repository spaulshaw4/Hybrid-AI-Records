import { describe, expect, it } from "vitest";
import {
  buildDynamicStylePrompt,
  concatStylePromptWithLyrics,
  isDynamicStylePrompt,
} from "@/lib/generation-style-prompt";

describe("buildDynamicStylePrompt", () => {
  it("uses the request genre, BPM, mood, and instruments verbatim", () => {
    expect(
      buildDynamicStylePrompt({
        genre: "Nu-Metal",
        bpm: 102,
        mood: "aggressive",
        instruments: ["distorted guitars", "808s"],
      }),
    ).toBe("Nu-Metal, aggressive, 102 BPM, distorted guitars, 808s");
  });

  it("does not invent BPM, mood, or instruments when they were not specified", () => {
    expect(buildDynamicStylePrompt({ genre: "Trap" })).toBe("Trap");
  });

  it("keeps a vocal profile without replacing it with stock vocals", () => {
    expect(
      buildDynamicStylePrompt({
        genre: "Heavy Rock",
        bpm: 92,
        vocalProfile: "Aggressive Rock Vocal",
      }),
    ).toBe("Heavy Rock, 92 BPM, Aggressive Rock Vocal vocals");
  });
});

describe("concatStylePromptWithLyrics", () => {
  it("concatenates stylePrompt directly with the user's lyrics", () => {
    expect(
      concatStylePromptWithLyrics("Nu-Metal, 102 BPM", "[Verse]\nNight drive"),
    ).toBe("Nu-Metal, 102 BPM\n\n[Verse]\nNight drive");
  });

  it("returns lyrics alone when there is no style prompt", () => {
    expect(concatStylePromptWithLyrics("", "[Chorus]\nGo")).toBe("[Chorus]\nGo");
    expect(concatStylePromptWithLyrics(null, "")).toBe("");
  });
});

describe("isDynamicStylePrompt", () => {
  it("detects artist style tags and BPM descriptors", () => {
    expect(isDynamicStylePrompt("[Style: Pop] [Tempo: 118 BPM]")).toBe(true);
    expect(isDynamicStylePrompt("pop, 118 BPM, bright")).toBe(true);
    expect(isDynamicStylePrompt("Nu-Metal, Male vocal, studio recording")).toBe(true);
    expect(isDynamicStylePrompt("just a vibe")).toBe(false);
  });
});
