/**
 * Request body for instant vocal clone (MessagePack on the wire).
 * Enhancement flags stay on so a phone take is cleaned before the mixer.
 */
export type VocalClonePayload = {
  text: string;
  format: "mp3" | "wav";
  normalize: true;
  enhance_audio_quality: true;
  latency: "normal";
  features: ["quality-guard"];
  prosody: { normalize_loudness: true };
  references: Array<{ audio: Uint8Array; text: "" }>;
};

export function buildVocalClonePayload(opts: {
  text: string;
  audio: Uint8Array;
  format: "mp3" | "wav";
}): VocalClonePayload {
  return {
    text: opts.text,
    format: opts.format,
    normalize: true,
    enhance_audio_quality: true,
    latency: "normal",
    features: ["quality-guard"],
    prosody: { normalize_loudness: true },
    references: [{ audio: opts.audio, text: "" }],
  };
}
