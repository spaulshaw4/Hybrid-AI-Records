import { describe, expect, it } from "vitest";
import { buildAceStepPayload } from "@/lib/ace-step-payload";
import {
  HYBRID_INTRO_SECONDS,
  HYBRID_TIMING_SPEC,
  planTimedHybridTrack,
} from "@/lib/hybrid-track-pipeline";

describe("buildAceStepPayload", () => {
  it("caps prompt length and keeps thinking/shift for vocal stems", () => {
    const payload = buildAceStepPayload({
      prompt: "x".repeat(800),
      lyrics: "[Verse]\nWe own the night",
      durationSeconds: 180,
    });
    expect(payload.input.prompt.length).toBe(512);
    expect(payload.input.lyrics).toContain("[Verse]");
    expect(payload.input.duration).toBe(180);
    expect(payload.input.thinking).toBe(true);
    expect(payload.input.shift).toBe(3.0);
    expect(payload.input.audio_format).toBe("mp3");
  });

  it("uses an instrumental lyric tag when lyrics are empty", () => {
    const payload = buildAceStepPayload({
      prompt: "Dark drums",
      lyrics: "   ",
      durationSeconds: 5,
    });
    expect(payload.input.lyrics).toBe("[Instrumental]");
    expect(payload.input.duration).toBe(10);
  });
});

describe("planTimedHybridTrack", () => {
  it("scopes ElevenLabs to 30s and runs MiniMax + ACE-Step for the core length", () => {
    const plan = planTimedHybridTrack({
      introPrompt: "Hybrid AI Records producer tag",
      mainStylePrompt: "Gritty southern rap, 92 BPM",
      lyricContent: "[Chorus]\nRaw words real music",
      totalDurationSec: 180,
    });

    expect(plan.introDuration).toBe(HYBRID_INTRO_SECONDS);
    expect(plan.intro.duration).toBe(30);
    expect(plan.intro.prompt).toContain("producer tag");
    expect(plan.coreSeconds).toBe(180);
    expect(plan.minimax.input.is_instrumental).toBe(true);
    expect(plan.minimax.input.lyrics).toBeUndefined();
    expect(plan.acestep.input.lyrics).toContain("Raw words");
    expect(plan.acestep.input.duration).toBe(180);
    expect(plan.timingSpec).toBe(HYBRID_TIMING_SPEC);
    expect(plan.engines).toEqual(["Intro tag", "Instrumental core", "Vocal stems"]);
  });

  it("fills a default intro prompt from the style when none is supplied", () => {
    const plan = planTimedHybridTrack({
      introPrompt: "  ",
      mainStylePrompt: "Cinematic trap",
      lyricContent: "verse",
    });
    expect(plan.intro.prompt).toContain("Cinematic trap");
    expect(plan.intro.prompt).toContain("30-second");
  });
});
