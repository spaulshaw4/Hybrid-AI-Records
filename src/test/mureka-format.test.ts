import { describe, expect, it } from "vitest";

import { formatMurekaLyrics, formatMurekaPrompt } from "@/lib/mureka-format";

describe("formatMurekaLyrics", () => {
  it("puts exactly one blank line between two sections", () => {
    const output = formatMurekaLyrics("[Verse]\nStanding at the edge...\n[Chorus]\nUnder heavy sky...");
    expect(output).toBe("[Verse]\nStanding at the edge...\n\n[Chorus]\nUnder heavy sky...");
    expect(output.includes("\n\n\n")).toBe(false);
  });

  it("replaces a bare [inst] with [inst-short]", () => {
    expect(formatMurekaLyrics("[Verse]\nline\n[inst]")).toBe("[Verse]\nline\n[inst-short]");
  });

  it("leaves [inst-medium] unchanged", () => {
    expect(formatMurekaLyrics("hold\n[inst-medium]\nback")).toBe("hold\n[inst-medium]\nback");
  });

  it("keeps long and named section tags intact", () => {
    const lyrics = [
      "[intro-long]",
      "[Verse 1]",
      "line",
      "[inst-long]",
      "[Chorus - Double]",
      "[outro-long]",
      "[Final Chord]",
      "[Fade Out]",
    ].join("\n");
    const output = formatMurekaLyrics(lyrics);
    for (const tag of ["[intro-long]", "[inst-long]", "[Chorus - Double]", "[outro-long]", "[Final Chord]", "[Fade Out]"]) {
      expect(output).toContain(tag);
    }
    expect(output).not.toContain("[inst-short]");
  });
});

describe("formatMurekaPrompt", () => {
  it("keeps Acoustic, heavy rock and adds 86 BPM once", () => {
    const output = formatMurekaPrompt("Acoustic, heavy rock", 86);
    expect(output).toBe("Acoustic, heavy rock, 86 BPM");
    expect(output.match(/86 BPM/g)).toEqual(["86 BPM"]);
  });
});
