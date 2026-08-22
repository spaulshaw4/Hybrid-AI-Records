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

  it("forwards bpm, voice_id, and reference_audio without dropping them", () => {
    const payload = buildAceStepPayload({
      prompt: "[Style: Nu-Metal] [Tempo: 102 BPM] [Vocals: Heavy / Nu-Metal]",
      lyrics: "[Verse]\nGo",
      durationSeconds: 180,
      bpm: 102,
      voiceId: "voice_9",
      referenceAudioUrl: "https://cdn.example/voice.wav",
    });
    expect(payload.input.bpm).toBe(102);
    expect(payload.input.voice_id).toBe("voice_9");
    expect(payload.input.reference_audio).toBe("https://cdn.example/voice.wav");
    expect(payload.input.prompt).toContain("[Tempo: 102 BPM]");
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

  it("keeps an explicit BPM and voice reference on the vocal payload", () => {
    const plan = planTimedHybridTrack({
      introPrompt: "tag",
      mainStylePrompt: "[Style: Trap] [Tempo: 140 BPM] [Vocals: Aggressive Trap Rap]",
      lyricContent: "[Chorus]\nGo",
      totalDurationSec: 180,
      bpm: 140,
      voiceId: "voice_custom_1",
      referenceAudioUrl: "https://example.com/take.wav",
    });
    expect(plan.acestep.input.prompt).toContain("[Style: Trap]");
    expect(plan.acestep.input.prompt).toContain("[Tempo: 140 BPM]");
    expect(plan.acestep.input.bpm).toBe(140);
    expect(plan.acestep.input.voice_id).toBe("voice_custom_1");
    expect(plan.acestep.input.reference_audio).toBe("https://example.com/take.wav");
    expect(plan.minimax.settings.voice_id).toBe("voice_custom_1");
    expect(plan.minimax.input.prompt).toContain("[Tempo: 140 BPM]");
    expect(plan.minimax.input.prompt).not.toMatch(/90-115 BPM|emotive contemporary/i);
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
