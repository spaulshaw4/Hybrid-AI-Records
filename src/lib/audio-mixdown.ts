/**
 * Browser-side multi-track mixdown.
 *
 * Decodes the generated backing track plus an uploaded vocal file, overlays
 * them with an OfflineAudioContext and encodes the result as a 16-bit WAV so
 * the player can offer a "Full Mix" download alongside the instrumental.
 */

export type MixResult = { url: string; blob: Blob; duration: number };

/** Deliverable spec for the Hybrid Master export: 16-bit PCM, 44.1 kHz. */
export const MASTER_SAMPLE_RATE = 44100;

/** Title/artist written into the WAV LIST/INFO chunk. */
export type MixMetadata = { title?: string; artist?: string };

import { sanitizeFileNamePart, sanitizeTagText } from "./audio-tags";

export const DEFAULT_ARTIST = "Hybrid AI Records";

function slug(value: string, fallback: string): string {
  return sanitizeFileNamePart(value).replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "") || fallback;
}

/** `[Track_Title]_[Artist]_Hybrid_Master.wav` download name for the exported mix. */
export function hybridMasterFileName(title: string, artist?: string): string {
  const parts = [slug(title, "Hybrid_Track")];
  const who = (artist ?? "").trim();
  if (who) parts.push(slug(who, "Artist"));
  return `${parts.join("_")}_Hybrid_Master.wav`;
}

/** Builds a RIFF LIST/INFO chunk carrying title (INAM) and artist (IART). */
function infoChunk(meta: MixMetadata): Uint8Array {
  const fields: Array<[string, string]> = [];
  const title = sanitizeTagText(meta.title);
  const artist = sanitizeTagText(meta.artist);
  if (title) fields.push(["INAM", title]);
  if (artist) fields.push(["IART", artist]);
  fields.push(["ISFT", "Hybrid Engine 1.0 Alpha"]);

  const encoder = new TextEncoder();
  const entries = fields.map(([id, value]) => {
    const text = encoder.encode(`${value}\0`);
    const padded = text.length % 2 === 1 ? text.length + 1 : text.length;
    return { id, text, padded };
  });

  const size = 4 + entries.reduce((total, e) => total + 8 + e.padded, 0);
  const out = new Uint8Array(8 + size);
  const view = new DataView(out.buffer);
  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "LIST");
  view.setUint32(4, size, true);
  writeString(8, "INFO");

  let offset = 12;
  for (const entry of entries) {
    writeString(offset, entry.id);
    view.setUint32(offset + 4, entry.text.length, true);
    out.set(entry.text, offset + 8);
    offset += 8 + entry.padded;
  }
  return out;
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function canMixInBrowser(): boolean {
  return getAudioContextCtor() !== null && typeof OfflineAudioContext !== "undefined";
}

async function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return await new Promise<AudioBuffer>((resolve, reject) => {
    // Callback form keeps Safari happy; it still resolves the promise form too.
    const maybe = ctx.decodeAudioData(data, resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
    if (maybe && typeof maybe.then === "function") maybe.then(resolve, reject);
  });
}

function encodeWav(buffer: AudioBuffer, meta: MixMetadata = {}): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const info = infoChunk(meta);
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));

  const writeString = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, bytes - 8 + info.length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, frames * channels * 2, true);

  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) {
      const sample = Math.max(-1, Math.min(1, data[c]![i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  // LIST/INFO trails the data chunk so players that ignore it still decode.
  return new Blob([view.buffer, info.buffer as ArrayBuffer], { type: "audio/wav" });
}

export type MixOptions = {
  /** 0–1.5 gain applied to the uploaded vocal. */
  vocalGain?: number;
  /** 0–1.5 gain applied to the generated backing track. */
  instrumentalGain?: number;
  /** Seconds to delay the vocal so it lines up with the beat. */
  vocalOffset?: number;
  /** Title/artist embedded in the exported WAV. */
  metadata?: MixMetadata;
  /** 1 = mono fold-down, 2 = stereo (default). */
  channels?: 1 | 2;
};

/**
 * Mixes an uploaded vocal file over a generated instrumental URL.
 * Throws a human-readable error when the backing track cannot be fetched
 * (usually a cross-origin CDN without CORS headers).
 */
export async function mixVocalWithTrack(
  instrumentalUrl: string,
  vocalFile: File,
  options: MixOptions = {},
): Promise<MixResult> {
  const Ctor = getAudioContextCtor();
  if (!Ctor || typeof OfflineAudioContext === "undefined") {
    throw new Error("This browser cannot mix audio locally.");
  }

  let instrumentalData: ArrayBuffer;
  try {
    const response = await fetch(instrumentalUrl, { mode: "cors" });
    if (!response.ok) throw new Error(String(response.status));
    instrumentalData = await response.arrayBuffer();
  } catch {
    throw new Error("Could not load the generated track for mixing. Download it and re-upload, or try again.");
  }

  const vocalData = await vocalFile.arrayBuffer();
  const ctx = new Ctor();
  try {
    const [bed, vocal] = await Promise.all([decode(ctx, instrumentalData), decode(ctx, vocalData)]);

    // Always render the deliverable at 16-bit / 44.1 kHz PCM.
    const sampleRate = MASTER_SAMPLE_RATE;
    const offset = Math.max(0, options.vocalOffset ?? 0);
    const duration = Math.max(bed.duration, vocal.duration + offset);
    const channels = options.channels === 1 ? 1 : 2;
    const offline = new OfflineAudioContext(channels, Math.ceil(duration * sampleRate), sampleRate);

    const bedGain = offline.createGain();
    bedGain.gain.value = options.instrumentalGain ?? 0.85;
    bedGain.connect(offline.destination);
    const bedSource = offline.createBufferSource();
    bedSource.buffer = bed;
    bedSource.connect(bedGain);
    bedSource.start(0);

    const vocalGain = offline.createGain();
    vocalGain.gain.value = options.vocalGain ?? 1;
    vocalGain.connect(offline.destination);
    const vocalSource = offline.createBufferSource();
    vocalSource.buffer = vocal;
    vocalSource.connect(vocalGain);
    vocalSource.start(offset);

    const rendered = await offline.startRendering();
    const blob = encodeWav(rendered, {
      artist: DEFAULT_ARTIST,
      ...(options.metadata ?? {}),
    });
    return { url: URL.createObjectURL(blob), blob, duration: rendered.duration };
  } finally {
    void ctx.close();
  }
}

/**
 * Downloads a generated master and re-encodes it as a 16-bit / 44.1 kHz PCM
 * WAV with title/artist metadata, so the studio can offer an instant
 * "Download Mastered WAV" next to the MP3 preview.
 */
export async function masterWavFromUrl(
  audioUrl: string,
  meta: MixMetadata = {},
): Promise<MixResult> {
  const Ctor = getAudioContextCtor();
  if (!Ctor || typeof OfflineAudioContext === "undefined") {
    throw new Error("This browser cannot export WAV locally.");
  }
  let data: ArrayBuffer;
  try {
    const response = await fetch(audioUrl, { mode: "cors" });
    if (!response.ok) throw new Error(String(response.status));
    data = await response.arrayBuffer();
  } catch {
    throw new Error("Could not load the master track for WAV export. Try the MP3 download instead.");
  }
  const ctx = new Ctor();
  try {
    const decoded = await decode(ctx, data);
    const channels = Math.min(2, Math.max(1, decoded.numberOfChannels)) as 1 | 2;
    const offline = new OfflineAudioContext(
      channels,
      Math.ceil(decoded.duration * MASTER_SAMPLE_RATE),
      MASTER_SAMPLE_RATE,
    );
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const blob = encodeWav(rendered, { artist: DEFAULT_ARTIST, ...meta });
    return { url: URL.createObjectURL(blob), blob, duration: rendered.duration };
  } finally {
    void ctx.close();
  }
}
