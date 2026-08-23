/**
 * Sample-rate sniffers for pipeline Gate 4. Browser-safe: no ffprobe.
 * WAV uses the fmt chunk; MP3 uses the first MPEG frame after an ID3 tag.
 */

const MPEG1_RATES = [44100, 48000, 32000] as const;
const MPEG2_RATES = [22050, 24000, 16000] as const;
const MPEG25_RATES = [11025, 12000, 8000] as const;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

export function readWavSampleRate(bytes: Uint8Array): number | null {
  if (bytes.byteLength < 36) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 16 <= bytes.byteLength) {
      const rate = view.getUint32(offset + 12, true);
      return rate > 0 ? rate : null;
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

function id3v2Size(bytes: Uint8Array): number {
  if (bytes.byteLength < 10) return 0;
  if (ascii(bytes, 0, 3) !== "ID3") return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  return 10 + size;
}

export function readMp3SampleRate(bytes: Uint8Array): number | null {
  const start = id3v2Size(bytes);
  const limit = Math.min(bytes.byteLength - 4, start + 8192);
  for (let i = start; i < limit; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (bytes[i + 1] >> 3) & 0x03;
    const srIndex = (bytes[i + 2] >> 2) & 0x03;
    if (srIndex === 3) continue;
    const table =
      versionBits === 3 ? MPEG1_RATES : versionBits === 2 ? MPEG2_RATES : MPEG25_RATES;
    return table[srIndex] ?? null;
  }
  return null;
}

export function readAudioSampleRate(bytes: Uint8Array): number | null {
  return readWavSampleRate(bytes) ?? readMp3SampleRate(bytes);
}

export function uniquePositiveRates(rates: Array<number | null | undefined>): number[] {
  return [...new Set(rates.filter((rate): rate is number => typeof rate === "number" && rate > 0))];
}
