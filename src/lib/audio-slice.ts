/**
 * Client-side audio slicing for the selective lip-sync stage.
 *
 * The master track is decoded once, then the exact window under each
 * `vocalSync` shot is cut out and encoded as a 16-bit PCM WAV so the lip-sync
 * model receives the same audio the audience will hear over that shot.
 */

import { fetchArrayBuffer } from "@/lib/safe-fetch";

export type DecodedMaster = { buffer: AudioBuffer; close: () => void };

export async function decodeMaster(source: Blob | string): Promise<DecodedMaster> {
  const AudioCtor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtor) throw new Error("This browser can't decode the master track.");
  const ctx = new AudioCtor();
  const bytes =
    typeof source === "string"
      ? await fetchArrayBuffer(source, {}, "Master track download")
      : await source.arrayBuffer();
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return { buffer, close: () => void ctx.close().catch(() => undefined) };
  } catch {
    void ctx.close().catch(() => undefined);
    throw new Error("The master track could not be decoded for lip-sync slicing.");
  }
}

function encodeWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const blockAlign = channelCount * 2;
  const dataSize = frames * blockAlign;
  const out = new Uint8Array(44 + dataSize);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel]![frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return out;
}

/** Cuts `[startSeconds, startSeconds + seconds)` out of the decoded master. */
export function sliceToWav(
  buffer: AudioBuffer,
  startSeconds: number,
  seconds: number,
): Uint8Array {
  const rate = buffer.sampleRate;
  const start = Math.max(0, Math.floor(startSeconds * rate));
  const length = Math.max(1, Math.min(buffer.length - start, Math.floor(seconds * rate)));
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const full = buffer.getChannelData(c);
    channels.push(full.slice(start, start + length));
  }
  return encodeWav(channels, rate);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
