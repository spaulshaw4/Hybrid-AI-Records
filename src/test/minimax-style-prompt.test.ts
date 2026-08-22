import { describe, expect, it, vi } from "vitest";
import { buildMiniMaxPayload } from "@/lib/apiframe-music.functions";

describe("buildMiniMaxPayload (MiniMax style serializer)", () => {
  it("builds a comma-separated style prompt and keeps lyrics separate", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = buildMiniMaxPayload({
      genre: "Nu-Metal",
      subGenre: "Rap Rock",
      bpm: 102,
      mood: "aggressive",
      instruments: ["distorted guitars", "808s"],
      vocalGender: "Male",
      vocalStyle: "Aggressive Rock Vocal",
      vocalTimbre: "Authentic lead",
      lyrics: "[Verse 1]\nNight drive",
    });

    expect(payload.model).toBe("music-2.6");
    expect(payload.prompt).toBe(
      "Nu-Metal, Rap Rock, 102 BPM, aggressive, distorted guitars, 808s, Male vocal, Aggressive Rock Vocal, Authentic lead, studio recording",
    );
    expect(payload.lyrics).toBe("[Verse 1]\nNight drive");
    expect(payload.is_instrumental).toBe(false);
    expect(payload.sample_rate).toBe(44100);
    expect(payload.bitrate).toBe(256000);
    expect(payload.audio_format).toBe("mp3");
    expect(payload.audio_url).toBeUndefined();
    expect(log).toHaveBeenCalledWith("[MINIMAX_STYLE_PROMPT]", payload.prompt);
    log.mockRestore();
  });

  it("defaults to a Male vocal and attaches cloned-voice audio_url", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = buildMiniMaxPayload({
      genre: "Trap",
      lyrics: "[Chorus]\nGo",
      voiceId: "voice_9",
      referenceAudioUrl: "https://cdn.example/take.wav",
    });
    expect(payload.prompt).toContain("Male vocal");
    expect(payload.prompt).toContain("studio recording");
    expect(payload.audio_url).toBe("https://cdn.example/take.wav");
    log.mockRestore();
  });
});
