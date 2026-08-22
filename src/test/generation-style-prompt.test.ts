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
    ).toBe(
      "[Style: Nu-Metal] [Tempo: 102 BPM] [Mood: aggressive] [Instruments: distorted guitars, 808s]",
    );
  });

  it("does not invent BPM, mood, or instruments when they were not specified", () => {
    expect(buildDynamicStylePrompt({ genre: "Trap" })).toBe("[Style: Trap]");
  });

  it("keeps a vocal profile without replacing it with stock vocals", () => {
    expect(
      buildDynamicStylePrompt({
        genre: "Heavy Rock",
        bpm: 92,
        vocalProfile: "Aggressive Rock Vocal",
      }),
    ).toBe("[Style: Heavy Rock] [Tempo: 92 BPM] [Vocals: Aggressive Rock Vocal]");
  });
});

describe("concatStylePromptWithLyrics", () => {
  it("concatenates stylePrompt directly with the user's lyrics", () => {
    expect(
      concatStylePromptWithLyrics("[Style: Trap] [Tempo: 140 BPM]", "[Verse]\nNight drive"),
    ).toBe("[Style: Trap] [Tempo: 140 BPM]\n\n[Verse]\nNight drive");
  });
});

describe("isDynamicStylePrompt", () => {
  it("detects artist Style and Tempo tags", () => {
    expect(isDynamicStylePrompt("[Style: Pop] [Tempo: 118 BPM]")).toBe(true);
    expect(isDynamicStylePrompt("pop, 118 bpm, bright")).toBe(false);
  });
});
