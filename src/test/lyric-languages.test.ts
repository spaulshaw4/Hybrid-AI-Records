import { describe, expect, it } from "vitest";
import {
  DEFAULT_LYRIC_LANGUAGE,
  isStudioStep1Complete,
  isValidLyricLanguage,
  lyricLanguageFieldSchema,
  lyricLanguageInstruction,
  VALID_LYRIC_LANGUAGE_VALUES,
} from "@/lib/lyric-languages";

describe("lyric language picker", () => {
  it("defaults to English", () => {
    expect(DEFAULT_LYRIC_LANGUAGE).toBe("en");
    expect(lyricLanguageFieldSchema.parse(undefined)).toBe("en");
  });

  it("accepts the supported ISO codes", () => {
    expect(VALID_LYRIC_LANGUAGE_VALUES).toEqual([
      "en",
      "es",
      "lt",
      "af",
      "fr",
      "de",
      "ja",
    ]);
    for (const code of VALID_LYRIC_LANGUAGE_VALUES) {
      expect(isValidLyricLanguage(code)).toBe(true);
      expect(lyricLanguageFieldSchema.parse(code)).toBe(code);
    }
  });

  it("coerces empty or legacy picker values to English", () => {
    expect(lyricLanguageFieldSchema.parse("")).toBe("en");
    expect(lyricLanguageFieldSchema.parse("auto")).toBe("en");
    expect(lyricLanguageFieldSchema.parse("custom")).toBe("en");
    expect(isValidLyricLanguage("")).toBe(false);
    expect(isValidLyricLanguage("auto")).toBe(false);
  });

  it("maps picker values to Gemini language names", () => {
    expect(lyricLanguageInstruction("en")).toBe("English");
    expect(lyricLanguageInstruction("lt")).toBe("Lithuanian (Lietuvių)");
    expect(lyricLanguageInstruction("ja")).toBe("Japanese (日本語)");
  });
});

describe("isStudioStep1Complete", () => {
  it("requires title and lyrics only", () => {
    expect(isStudioStep1Complete({ title: "Night Drive", lyrics: "[Verse]\nGo", language: "en" })).toBe(
      true,
    );
    expect(isStudioStep1Complete({ title: "  ", lyrics: "words", language: "en" })).toBe(false);
    expect(isStudioStep1Complete({ title: "Night Drive", lyrics: "  ", language: "en" })).toBe(false);
    expect(isStudioStep1Complete({ title: "Night Drive", lyrics: "words", language: "" })).toBe(true);
  });
});
