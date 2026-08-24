import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lyricEngineAuthToken,
  lyricReplicateToken,
} from "@/lib/replicate-llm.server";

const KEYS = ["LYRIC_ENGINE_API_KEY", "ENGINE_API_KEY", "REPLICATE_API_KEY", "REPLICATE_API_TOKEN"] as const;

describe("lyric engine auth isolation", () => {
  const original = Object.fromEntries(KEYS.map((name) => [name, process.env[name]])) as Record<
    (typeof KEYS)[number],
    string | undefined
  >;

  afterEach(() => {
    for (const name of KEYS) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    vi.restoreAllMocks();
  });

  function clearAll() {
    for (const name of KEYS) delete process.env[name];
  }

  it("reads process.env.LYRIC_ENGINE_API_KEY explicitly", () => {
    clearAll();
    process.env.LYRIC_ENGINE_API_KEY = "r8_lyric_only";
    process.env.REPLICATE_API_TOKEN = "r8_hybrid_demucs";
    expect(lyricEngineAuthToken()).toBe("r8_lyric_only");
    expect(lyricReplicateToken()).toBe("r8_lyric_only");
  });

  it("accepts ENGINE_API_KEY as the only alias", () => {
    clearAll();
    process.env.ENGINE_API_KEY = "r8_engine_alias";
    process.env.REPLICATE_API_TOKEN = "r8_hybrid_demucs";
    expect(lyricEngineAuthToken()).toBe("r8_engine_alias");
  });

  it("does not fall back to REPLICATE_API_TOKEN when lyric keys are missing", () => {
    clearAll();
    process.env.REPLICATE_API_TOKEN = "r8_hybrid_demucs";
    process.env.REPLICATE_API_KEY = "r8_hybrid_alias";
    expect(() => lyricEngineAuthToken()).toThrow(/LYRIC_ENGINE_API_KEY/);
    expect(() => lyricReplicateToken()).toThrow(/LYRIC_ENGINE_API_KEY|not configured/i);
  });

  it("refuses when LYRIC_ENGINE_API_KEY is identical to the hybrid token", () => {
    clearAll();
    process.env.LYRIC_ENGINE_API_KEY = "r8_same_token";
    process.env.REPLICATE_API_TOKEN = "r8_same_token";
    expect(() => lyricEngineAuthToken("Co-Producer")).toThrow(/must not be the hybrid/i);
  });
});
