import { readStoredVocalConsent } from "@/lib/vocal-consent";

export const CORE_STYLE_SELECT_ID = "core-style-select";
export const DEFAULT_AI_VOCAL_SELECT_ID = "default-ai-vocal-select";
export const CUSTOM_AUDIO_FILE_INPUT_ID = "custom-audio-file-input";
export const SONG_LYRICS_INPUT_ID = "song-lyrics-input";
export const VIDEO_PROMPT_INPUT_ID = "video-prompt-input";
export const GENERATE_TRACK_BTN_ID = "generate-track-btn";
export const VOCAL_MODE_NAME = "vocal-mode";
export const AI_VOCAL_STYLING_ID = "ai-vocal-styling";
export const VOCAL_SOUND_CONTROLS_ID = "vocal-sound-controls";

export type VocalMode = "default-ai" | "custom-upload";

export const STUDIO_STYLE_REQUIRED =
  "Please select a core style or genre for the track.";
export const STUDIO_VOCAL_SOURCE_REQUIRED =
  "Please choose a valid vocal source (Default AI or Custom Upload).";
export const STUDIO_CUSTOM_CONSENT_REQUIRED =
  "Legal Action Required: You must check the liability acknowledgment box to use custom-cloned or uploaded vocals.";
export const STUDIO_CUSTOM_FILE_REQUIRED =
  "No custom vocal audio file selected for upload.";
export const STUDIO_CUSTOM_VOICE_UNSAVED =
  "Save your recorded or uploaded take with Use my voice before generating.";

export type DefaultVocalConfig = {
  type: "default";
  reference_id: string;
  terms_accepted: true;
};

export type CustomVocalConfig = {
  type: "custom";
  file: File | Blob | null;
  voice_id?: string;
  terms_accepted: true;
};

export type InstrumentalVocalConfig = {
  type: "instrumental";
  terms_accepted: true;
};

export type StudioVocalConfig =
  | DefaultVocalConfig
  | CustomVocalConfig
  | InstrumentalVocalConfig;

export type ValidatedStudioPayload = {
  style: string;
  lyrics: string;
  video_prompt: string;
  vocal_config: StudioVocalConfig;
};

export type StudioPayloadInput = {
  style: string;
  lyrics?: string;
  videoPrompt?: string;
  withVocals: boolean;
  vocalMode: string | null | undefined;
  defaultVoiceId?: string;
  termsAccepted?: boolean;
  customAudioFile?: File | Blob | null;
  customVoiceId?: string;
};

/**
 * Unified studio payload controller. Style and vocal source are validated
 * together so Default AI and custom-upload cannot be mixed into one request.
 */
export function getValidatedStudioPayload(input: StudioPayloadInput): ValidatedStudioPayload {
  const style = input.style.trim();
  if (!style) {
    throw new Error(STUDIO_STYLE_REQUIRED);
  }

  const lyrics = input.lyrics ?? "";
  const video_prompt = input.videoPrompt ?? "";

  if (!input.withVocals) {
    return {
      style,
      lyrics,
      video_prompt,
      vocal_config: { type: "instrumental", terms_accepted: true },
    };
  }

  if (input.vocalMode === "default-ai") {
    return {
      style,
      lyrics,
      video_prompt,
      vocal_config: {
        type: "default",
        reference_id: (input.defaultVoiceId || "ai").trim() || "ai",
        terms_accepted: true,
      },
    };
  }

  if (input.vocalMode === "custom-upload") {
    const consented = input.termsAccepted === true || readStoredVocalConsent();
    if (!consented) {
      throw new Error(STUDIO_CUSTOM_CONSENT_REQUIRED);
    }
    const file = input.customAudioFile ?? null;
    const voiceId = (input.customVoiceId ?? "").trim();
    if (!file && !voiceId) {
      throw new Error(STUDIO_CUSTOM_FILE_REQUIRED);
    }
    if (file && !voiceId) {
      throw new Error(STUDIO_CUSTOM_VOICE_UNSAVED);
    }
    return {
      style,
      lyrics,
      video_prompt: "",
      vocal_config: {
        type: "custom",
        file,
        ...(voiceId ? { voice_id: voiceId } : {}),
        terms_accepted: true,
      },
    };
  }

  throw new Error(STUDIO_VOCAL_SOURCE_REQUIRED);
}

/** True when generate should send a cloned/uploaded voice id. */
export function usesCustomVocal(payload: ValidatedStudioPayload): boolean {
  return payload.vocal_config.type === "custom";
}

/** AI vocal-sound tags and synthetic voice chips apply only to Default AI Vocal. */
export function usesDefaultAiVocal(
  withVocals: boolean,
  vocalMode: string | null | undefined,
): boolean {
  return withVocals && vocalMode === "default-ai";
}
