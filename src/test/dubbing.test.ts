import { describe, expect, it } from "vitest";
import {
  clampCloningStrength,
  DEFAULT_CLONING_STRENGTH,
  DUBBING_TARGET_LANGUAGES,
  parseDubbingOutput,
  resolveDubbingLanguage,
} from "@/lib/dubbing.server";

describe("resolveDubbingLanguage", () => {
  it("accepts the model's own BCP-47 tags", () => {
    expect(resolveDubbingLanguage("es")).toBe("es");
    expect(resolveDubbingLanguage("pt-BR")).toBe("pt-BR");
    expect(resolveDubbingLanguage("zh-TW")).toBe("zh-TW");
  });

  it("normalizes casing the studio might send", () => {
    expect(resolveDubbingLanguage("PT-br")).toBe("pt-BR");
    expect(resolveDubbingLanguage("ES")).toBe("es");
  });

  it("falls back to the base language for an unlisted region", () => {
    // "es-CO" is not offered; the base Spanish tag is.
    expect(resolveDubbingLanguage("es-CO")).toBe("es");
  });

  it("rejects a language the model cannot dub", () => {
    expect(resolveDubbingLanguage("klingon")).toBeNull();
    expect(resolveDubbingLanguage("")).toBeNull();
    expect(resolveDubbingLanguage(undefined)).toBeNull();
  });

  it("covers the full published language set", () => {
    expect(DUBBING_TARGET_LANGUAGES).toHaveLength(108);
    for (const tag of DUBBING_TARGET_LANGUAGES) {
      expect(resolveDubbingLanguage(tag)).toBe(tag);
    }
  });
});

describe("clampCloningStrength", () => {
  it("keeps the model's 0-10 integer range", () => {
    expect(clampCloningStrength(7)).toBe(7);
    expect(clampCloningStrength(0)).toBe(0);
    expect(clampCloningStrength(10)).toBe(10);
    expect(clampCloningStrength(42)).toBe(10);
    expect(clampCloningStrength(-3)).toBe(0);
    expect(clampCloningStrength(6.6)).toBe(7);
  });

  it("defaults to the documented 7 when unset", () => {
    expect(clampCloningStrength(undefined)).toBe(DEFAULT_CLONING_STRENGTH);
    expect(DEFAULT_CLONING_STRENGTH).toBe(7);
  });
});

describe("parseDubbingOutput", () => {
  it("reads a bare URL, an array, and an object", () => {
    expect(parseDubbingOutput("https://replicate.delivery/dub.mp3")).toBe(
      "https://replicate.delivery/dub.mp3",
    );
    expect(parseDubbingOutput(["https://replicate.delivery/a.mp3"])).toBe(
      "https://replicate.delivery/a.mp3",
    );
    expect(parseDubbingOutput({ audio: "https://replicate.delivery/b.mp3" })).toBe(
      "https://replicate.delivery/b.mp3",
    );
    expect(parseDubbingOutput({ audio_url: "https://replicate.delivery/c.mp3" })).toBe(
      "https://replicate.delivery/c.mp3",
    );
  });

  it("ignores values the mixer could not fetch", () => {
    expect(parseDubbingOutput("/api/local-vault/dub.mp3")).toBeNull();
    expect(parseDubbingOutput(null)).toBeNull();
    expect(parseDubbingOutput({})).toBeNull();
  });
});
