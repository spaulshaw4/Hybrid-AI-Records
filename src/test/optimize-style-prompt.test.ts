import { describe, expect, it } from "vitest";
import {
  buildStyleOptimizePrompt,
  cleanOptimizedStylePrompt,
} from "@/lib/optimize-style-prompt.server";

describe("buildStyleOptimizePrompt", () => {
  it("embeds the user concept and Prompt Book formula", () => {
    const prompt = buildStyleOptimizePrompt("grunge rock night drive");
    expect(prompt).toContain("100K Prompt Book formula");
    expect(prompt).toContain('User Concept: "grunge rock night drive"');
    expect(prompt).toContain("carries the hook while");
    expect(prompt).toContain("persistent rhythm section");
    expect(prompt).toContain("solid continuous bassline");
    expect(prompt).toContain("without sudden dropouts");
    expect(prompt).toContain("Return ONLY the raw prompt string");
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
