/**
 * Request body for instant vocal clone (MessagePack on the wire).
 * Enhancement flags stay on so a phone take is cleaned before the mixer.
 */
export type VocalCloneReference = { audio: Uint8Array; text: string };

export type VocalClonePayload = {
  text: string;
  format: "mp3" | "wav";
  /**
   * Fish normalizes text for *English* conventions (numbers, dates, currency).
   * Leaving it on for other languages risks mangling native spelling, so the
   * caller turns it off for non-English lyrics.
   */
  normalize: boolean;
  enhance_audio_quality: true;
  latency: "normal";
  features: ["quality-guard"];
  prosody: { normalize_loudness: true };
  references?: VocalCloneReference[];
};

export function buildVocalClonePayload(opts: {
  text: string;
  audio?: Uint8Array;
  extraReferences?: Uint8Array[];
  format: "mp3" | "wav";
  /** Language hint from the studio; anything but English disables normalize. */
  language?: string;
}): VocalClonePayload {
  const references: VocalCloneReference[] = [];
  if (opts.audio && opts.audio.byteLength >= 256) {
    references.push({ audio: opts.audio, text: opts.text.slice(0, 500) });
  }
  for (const extra of opts.extraReferences ?? []) {
    if (extra.byteLength >= 256) references.push({ audio: extra, text: "" });
  }
  const language = opts.language?.trim().toLowerCase();
  const isEnglish = !language || language === "en" || language === "auto";
  return {
    text: opts.text,
    format: opts.format,
    normalize: isEnglish,
    enhance_audio_quality: true,
    latency: "normal",
    features: ["quality-guard"],
    prosody: { normalize_loudness: true },
    ...(references.length > 0 ? { references } : {}),
  };
}
