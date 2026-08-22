import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnv, requireStageKey } from "@/lib/env";

const KEYS = [
  "MUSIC_API_KEY",
  "VITE_MUSIC_API_KEY",
  "SONIC_API_KEY",
  "MUSICAPI_KEY",
  "REPLICATE_API_TOKEN",
  "REPLICATE_API_KEY",
  "FISH_AUDIO_API_KEY",
  "FISH_API_KEY",
  "MATCHERING_PYTHON",
] as const;

describe("requireStageKey", () => {
  const original: Record<(typeof KEYS)[number], string | undefined> = {
    MUSIC_API_KEY: process.env.MUSIC_API_KEY,
    VITE_MUSIC_API_KEY: process.env.VITE_MUSIC_API_KEY,
    SONIC_API_KEY: process.env.SONIC_API_KEY,
    MUSICAPI_KEY: process.env.MUSICAPI_KEY,
    REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN,
    REPLICATE_API_KEY: process.env.REPLICATE_API_KEY,
    FISH_AUDIO_API_KEY: process.env.FISH_AUDIO_API_KEY,
    FISH_API_KEY: process.env.FISH_API_KEY,
    MATCHERING_PYTHON: process.env.MATCHERING_PYTHON,
  };

  afterEach(() => {
    for (const name of KEYS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    vi.restoreAllMocks();
  });

  function clear(keys: readonly string[]) {
    for (const name of keys) delete process.env[name];
  }

  it("reads MUSIC_API_KEY for the MusicAPI stage", () => {
    clear(["MUSIC_API_KEY", "VITE_MUSIC_API_KEY", "SONIC_API_KEY", "MUSICAPI_KEY"]);
    process.env.MUSIC_API_KEY = "music-key";
    expect(requireStageKey("MUSIC_API_KEY", "MusicAPI (Base Arrangement)")).toBe("music-key");
  });

  it("falls back to VITE_MUSIC_API_KEY", () => {
    clear(["MUSIC_API_KEY", "VITE_MUSIC_API_KEY", "SONIC_API_KEY", "MUSICAPI_KEY"]);
    process.env.VITE_MUSIC_API_KEY = "vite-key";
    expect(requireStageKey("MUSIC_API_KEY", "MusicAPI (Base Arrangement)")).toBe("vite-key");
  });

  it("names the failing MusicAPI stage when the key is missing", () => {
    clear(["MUSIC_API_KEY", "VITE_MUSIC_API_KEY", "SONIC_API_KEY", "MUSICAPI_KEY"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const message =
      "[PIPELINE_INIT_FAILED] MusicAPI (Base Arrangement) failed: Missing MUSIC_API_KEY";
    expect(() => requireStageKey("MUSIC_API_KEY", "MusicAPI (Base Arrangement)")).toThrow(message);
    expect(error).toHaveBeenCalledWith(message);
  });

  it("names Stem Separation when REPLICATE_API_TOKEN is missing", () => {
    clear(["REPLICATE_API_TOKEN", "REPLICATE_API_KEY"]);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const message =
      "[PIPELINE_INIT_FAILED] Stem Separation failed: Missing REPLICATE_API_TOKEN";
    expect(() => requireStageKey("REPLICATE_API_TOKEN", "Stem Separation")).toThrow(message);
    expect(error).toHaveBeenCalledWith(message);
  });

  it("accepts FISH_API_KEY as an alias for Fish Audio vocals", () => {
    clear(["FISH_AUDIO_API_KEY", "FISH_API_KEY"]);
    process.env.FISH_API_KEY = "fish-key";
    expect(requireStageKey("FISH_AUDIO_API_KEY", "Fish Audio (Vocals)")).toBe("fish-key");
  });

  it("names Fish Audio when both vocal keys are missing", () => {
    clear(["FISH_AUDIO_API_KEY", "FISH_API_KEY"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const message =
      "[PIPELINE_INIT_FAILED] Fish Audio (Vocals) failed: Missing FISH_AUDIO_API_KEY";
    expect(() => requireStageKey("FISH_AUDIO_API_KEY", "Fish Audio (Vocals)")).toThrow(message);
  });

  it("readEnv returns undefined instead of throwing", () => {
    delete process.env.MATCHERING_PYTHON;
    expect(readEnv("MATCHERING_PYTHON")).toBeUndefined();
  });
});
