import { describe, expect, it, vi } from "vitest";
import {
  PIPELINE_STEP_LOGS,
  logPipelineStep,
  logPipelineStepError,
  lyricPipelineKey,
  vocalPipelineKey,
} from "@/lib/pipeline-steps.server";

describe("pipeline step telemetry", () => {
  it("emits the five runtime gate logs plus the Co-Producer lyric step", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logPipelineStep("lyrics");
    logPipelineStep("music");
    logPipelineStep("handoff");
    logPipelineStep("stems");
    logPipelineStep("vocals");
    logPipelineStep("mastering");
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.lyrics);
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.music);
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.handoff);
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.stems);
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.vocals);
    expect(log).toHaveBeenCalledWith(PIPELINE_STEP_LOGS.mastering);
    log.mockRestore();
  });

  it("numbers the runtime gates 1 through 5 in execution order", () => {
    expect([
      PIPELINE_STEP_LOGS.music,
      PIPELINE_STEP_LOGS.handoff,
      PIPELINE_STEP_LOGS.stems,
      PIPELINE_STEP_LOGS.vocals,
      PIPELINE_STEP_LOGS.mastering,
    ]).toEqual([
      expect.stringContaining("[1/5: BASE GENERATION]"),
      expect.stringContaining("[2/5: BASE URL HANDOFF]"),
      expect.stringContaining("[3/5: STEMS]"),
      expect.stringContaining("[4/5: VOCALS]"),
      expect.stringContaining("[5/5: MASTERING]"),
    ]);
  });

  it("logs the provider name and body without throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      logPipelineStepError("music", new Error("bad key"), { status: 401, body: "unauthorized" }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      ">>> [MUSIC] AIMusicAPI chirp-v5 ERROR",
      401,
      "unauthorized",
    );
    error.mockRestore();
  });

  it("isolates lyric keys from ENGINE_API_KEY", () => {
    const engine = process.env.ENGINE_API_KEY;
    const lyric = process.env.LYRIC_ENGINE_API_KEY;
    const replicate = process.env.REPLICATE_API_KEY;
    delete process.env.LYRIC_ENGINE_API_KEY;
    delete process.env.REPLICATE_API_KEY;
    process.env.ENGINE_API_KEY = "engine-only";
    expect(lyricPipelineKey()).toBeUndefined();
    if (engine === undefined) delete process.env.ENGINE_API_KEY;
    else process.env.ENGINE_API_KEY = engine;
    if (lyric === undefined) delete process.env.LYRIC_ENGINE_API_KEY;
    else process.env.LYRIC_ENGINE_API_KEY = lyric;
    if (replicate === undefined) delete process.env.REPLICATE_API_KEY;
    else process.env.REPLICATE_API_KEY = replicate;
  });

  it("prefers FISH_AUDIO_API_KEY for vocals", () => {
    const fish = process.env.FISH_API_KEY;
    const audio = process.env.FISH_AUDIO_API_KEY;
    process.env.FISH_AUDIO_API_KEY = "audio-key";
    process.env.FISH_API_KEY = "legacy-key";
    expect(vocalPipelineKey()).toBe("audio-key");
    if (fish === undefined) delete process.env.FISH_API_KEY;
    else process.env.FISH_API_KEY = fish;
    if (audio === undefined) delete process.env.FISH_AUDIO_API_KEY;
    else process.env.FISH_AUDIO_API_KEY = audio;
  });
});
