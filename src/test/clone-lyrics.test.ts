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
    const audio = new Uint8Array(256).fill(1);
    const payload = buildVocalClonePayload({
      text: "We own the night",
      audio,
      format: "mp3",
    });
    expect(payload.enhance_audio_quality).toBe(true);
    expect(payload.normalize).toBe(true);
    expect(payload.prosody.normalize_loudness).toBe(true);
    expect(payload.features).toEqual(["quality-guard"]);
    expect(payload.references?.[0]?.text).toBe("We own the night");
    expect(payload.references?.[0]?.audio).toBe(audio);
  });

  it("keeps English text normalization off for other languages", () => {
    // Fish normalizes for English conventions, which mangles native spelling.
    const lithuanian = buildVocalClonePayload({
      text: "Aš girdžiu tavo balsą",
      format: "mp3",
      language: "lt",
    });
    expect(lithuanian.normalize).toBe(false);
    expect(lithuanian.text).toBe("Aš girdžiu tavo balsą");

    expect(buildVocalClonePayload({ text: "x", format: "mp3", language: "en" }).normalize).toBe(true);
    expect(buildVocalClonePayload({ text: "x", format: "mp3", language: "auto" }).normalize).toBe(
      true,
    );
    expect(buildVocalClonePayload({ text: "x", format: "mp3" }).normalize).toBe(true);
  });

  it("preserves non-Latin lyrics through the clone text pass", () => {
    expect(lyricsForCloneSpeech("[Verse]\n夜が明ける\n[Chorus]\nमैं गाता हूँ")).toBe(
      "夜が明ける मैं गाता हूँ",
    );
  });
});
