/**
 * Request body for instant vocal clone (MessagePack on the wire).
 * Enhancement flags stay on so a phone take is cleaned before the mixer.
 */
export type VocalCloneReference = { audio: Uint8Array; text: string };

export type VocalClonePayload = {
  text: string;
  format: "mp3" | "wav";
  normalize: true;
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
}): VocalClonePayload {
  const references: VocalCloneReference[] = [];
  if (opts.audio && opts.audio.byteLength >= 256) {
    references.push({ audio: opts.audio, text: opts.text.slice(0, 500) });
  }
  for (const extra of opts.extraReferences ?? []) {
    if (extra.byteLength >= 256) references.push({ audio: extra, text: "" });
  }
  return {
    text: opts.text,
    format: opts.format,
    normalize: true,
    enhance_audio_quality: true,
    latency: "normal",
    features: ["quality-guard"],
    prosody: { normalize_loudness: true },
    ...(references.length > 0 ? { references } : {}),
  };
}
