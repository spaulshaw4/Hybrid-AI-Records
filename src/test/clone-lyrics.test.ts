import { describe, expect, it } from "vitest";
import { languageHintForClone, lyricsForCloneSpeech } from "@/lib/clone-lyrics";
import { newInstantVoiceId, samplePathFromUrl } from "@/lib/instant-voice";
import { buildVocalClonePayload } from "@/lib/vocal-clone-payload";

describe("lyricsForCloneSpeech", () => {
  it("strips structure tags so the clone sings words, not labels", () => {
    expect(
      lyricsForCloneSpeech(`[Verse]\nWe own the night\n[Chorus]\nRaw words real music`),
    ).toBe("We own the night Raw words real music");
  });

  it("returns empty when the brief is only tags", () => {
    expect(lyricsForCloneSpeech("[Instrumental]\n[Outro]")).toBe("");
  });
});

describe("languageHintForClone", () => {
  it("maps studio language picks to short hints", () => {
    expect(languageHintForClone("auto")).toBe("en");
    expect(languageHintForClone("en")).toBe("en");
    expect(languageHintForClone("lt")).toBe("lt");
    expect(languageHintForClone("es")).toBe("es");
    expect(languageHintForClone("sw")).toBe("sw");
    expect(languageHintForClone("custom", "Lithuanian")).toBe("lt");
  });
});

describe("instant voice handle", () => {
  it("issues a short local voice id", () => {
    const id = newInstantVoiceId();
    expect(id.startsWith("voice_")).toBe(true);
    expect(id.length).toBeLessThanOrEqual(40);
  });

  it("pulls the storage path out of a signed voice-samples URL", () => {
    expect(
      samplePathFromUrl(
        "https://example.supabase.co/storage/v1/object/sign/voice-samples/user-1/take.wav?token=abc",
      ),
    ).toBe("user-1/take.wav");
  });
});

describe("buildVocalClonePayload", () => {
  it("turns on clip enhancement for the mixer stem", () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const payload = buildVocalClonePayload({
      text: "We own the night",
      audio,
      format: "mp3",
    });
    expect(payload.enhance_audio_quality).toBe(true);
    expect(payload.normalize).toBe(true);
    expect(payload.prosody.normalize_loudness).toBe(true);
    expect(payload.features).toEqual(["quality-guard"]);
    expect(payload.references?.[0]?.text).toBe("");
    expect(payload.references?.[0]?.audio).toBe(audio);
  });
});
