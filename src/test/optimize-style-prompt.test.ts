import { describe, expect, it } from "vitest";
import {
  buildStyleOptimizePrompt,
  cleanOptimizedStylePrompt,
  injectLyricStructureAnchors,
  parseOptimizedStyleOutput,
} from "@/lib/optimize-style-prompt.server";

describe("buildStyleOptimizePrompt", () => {
  it("requires genre-adaptive dense tokens and dual lyric-anchor output", () => {
    const prompt = buildStyleOptimizePrompt("afrobeats night drive", {
      lyrics: "[Verse 1]\nCity lights glow",
    });
    expect(prompt).toContain('User Concept: "afrobeats night drive"');
    expect(prompt).toContain(
      "[Tempo/BPM], [Primary Low-End/Bass Instrument for that genre], [Primary Drum/Percussion Kit for that genre], [Harmonic/Melodic Layers], [Vocal Style & Delivery], [Atmosphere/Mix Profile], [Theme/Concept]",
    );
    expect(prompt).toContain("STYLE_TOKENS:");
    expect(prompt).toContain("LYRIC_ANCHORS:");
    expect(prompt).toContain("never default to rock/grunge");
    expect(prompt).toContain("City lights glow");
    expect(prompt).not.toContain("100K Prompt Book formula");
    expect(prompt).not.toContain("punchy acoustic drums, prominent driving bassline");
  });
});

describe("parseOptimizedStyleOutput", () => {
  it("splits STYLE_TOKENS and LYRIC_ANCHORS blocks", () => {
    const parsed = parseOptimizedStyleOutput(`STYLE_TOKENS:
98 BPM, deep 808 sub bass, crisp trap hats, dark synth pads, melodic rap, wide stereo, night drive

LYRIC_ANCHORS:
[808 Bass Intro]
[Hook - Booming Low End]
[Verse - Pocket Flow]
[Outro - Sub Fade]`);
    expect(parsed.stylePrompt).toContain("98 BPM");
    expect(parsed.stylePrompt).toContain("deep 808 sub bass");
    expect(parsed.lyricAnchors).toEqual([
      "[808 Bass Intro]",
      "[Hook - Booming Low End]",
      "[Verse - Pocket Flow]",
      "[Outro - Sub Fade]",
    ]);
  });

  it("falls back to style-only when anchors are missing", () => {
    const parsed = parseOptimizedStyleOutput("120 BPM, four-on-the-floor kick, rolling bassline");
    expect(parsed.stylePrompt).toContain("120 BPM");
    expect(parsed.lyricAnchors).toEqual([]);
  });
});

describe("injectLyricStructureAnchors", () => {
  it("builds a roadmap when lyrics are empty", () => {
    expect(
      injectLyricStructureAnchors("", ["[Intro - Four on the Floor]", "[Drop - Sub Bass]"]),
    ).toBe("[Intro - Four on the Floor]\n\n[Drop - Sub Bass]");
  });

  it("replaces existing bracket tags in order without touching sung lines", () => {
    const next = injectLyricStructureAnchors(
      "[Verse 1]\nCity lights glow\n[Chorus]\nWe ride all night",
      ["[Intro - Heavy Bass Riff]", "[Chorus - Full Band]"],
    );
    expect(next).toBe(
      "[Intro - Heavy Bass Riff]\nCity lights glow\n[Chorus - Full Band]\nWe ride all night",
    );
  });
});

describe("cleanOptimizedStylePrompt", () => {
  it("strips markdown fences and quotes", () => {
    expect(
      cleanOptimizedStylePrompt(
        '```\n"Alternative Rock, 101 BPM, raspy lead; guitars carry the hook while drums fill the space — theme: night"\n```',
      ),
    ).toBe(
      "Alternative Rock, 101 BPM, raspy lead; guitars carry the hook while drums fill the space — theme: night",
    );
  });
});
