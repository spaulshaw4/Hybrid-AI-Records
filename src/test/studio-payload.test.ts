import { describe, expect, it, beforeEach } from "vitest";
import {
  STUDIO_CUSTOM_CONSENT_REQUIRED,
  STUDIO_CUSTOM_FILE_REQUIRED,
  STUDIO_CUSTOM_VOICE_UNSAVED,
  STUDIO_STYLE_REQUIRED,
  STUDIO_VOCAL_SOURCE_REQUIRED,
  getValidatedStudioPayload,
  usesCustomVocal,
  usesDefaultAiVocal,
} from "@/lib/studio-payload";
import { VOCAL_LIABILITY_SESSION_KEY } from "@/lib/vocal-consent";

const base = {
  style: "Afrobeats",
  lyrics: "[Verse]\nHello",
  videoPrompt: "",
  withVocals: true,
  defaultVoiceId: "ai",
};

describe("getValidatedStudioPayload", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("requires a core style", () => {
    expect(() =>
      getValidatedStudioPayload({ ...base, style: "  ", vocalMode: "default-ai" }),
    ).toThrow(STUDIO_STYLE_REQUIRED);
  });

  it("lets Default AI bypass the legal check", () => {
    const payload = getValidatedStudioPayload({
      ...base,
      vocalMode: "default-ai",
      termsAccepted: false,
      customVoiceId: "should-be-ignored",
    });
    expect(payload.vocal_config).toEqual({
      type: "default",
      reference_id: "ai",
      terms_accepted: true,
    });
    expect(usesCustomVocal(payload)).toBe(false);
  });

  it("blocks custom-upload without consent", () => {
    expect(() =>
      getValidatedStudioPayload({
        ...base,
        vocalMode: "custom-upload",
        termsAccepted: false,
        customAudioFile: new Blob(["x"]),
        customVoiceId: "voice_1",
      }),
    ).toThrow(STUDIO_CUSTOM_CONSENT_REQUIRED);
  });

  it("blocks custom-upload with no file and no saved voice", () => {
    expect(() =>
      getValidatedStudioPayload({
        ...base,
        vocalMode: "custom-upload",
        termsAccepted: true,
      }),
    ).toThrow(STUDIO_CUSTOM_FILE_REQUIRED);
  });

  it("blocks a take that was not saved as a voice", () => {
    expect(() =>
      getValidatedStudioPayload({
        ...base,
        vocalMode: "custom-upload",
        termsAccepted: true,
        customAudioFile: new Blob(["x"]),
      }),
    ).toThrow(STUDIO_CUSTOM_VOICE_UNSAVED);
  });

  it("accepts custom-upload with consent and a saved voice", () => {
    sessionStorage.setItem(VOCAL_LIABILITY_SESSION_KEY, "true");
    const file = new Blob(["x"]);
    const payload = getValidatedStudioPayload({
      ...base,
      vocalMode: "custom-upload",
      videoPrompt: "rasp, male baritone",
      customAudioFile: file,
      customVoiceId: "voice_1",
    });
    expect(payload.vocal_config).toEqual({
      type: "custom",
      file,
      voice_id: "voice_1",
      terms_accepted: true,
    });
    expect(usesCustomVocal(payload)).toBe(true);
    expect(payload.video_prompt).toBe("");
  });

  it("only enables AI vocal-sound controls for Default AI Vocal", () => {
    expect(usesDefaultAiVocal(true, "default-ai")).toBe(true);
    expect(usesDefaultAiVocal(true, "custom-upload")).toBe(false);
    expect(usesDefaultAiVocal(false, "default-ai")).toBe(false);
  });

  it("skips vocal-source rules for instrumental tracks", () => {
    const payload = getValidatedStudioPayload({
      ...base,
      withVocals: false,
      vocalMode: null,
    });
    expect(payload.vocal_config.type).toBe("instrumental");
  });

  it("rejects an unknown vocal mode", () => {
    expect(() =>
      getValidatedStudioPayload({ ...base, vocalMode: "both" }),
    ).toThrow(STUDIO_VOCAL_SOURCE_REQUIRED);
  });
});
