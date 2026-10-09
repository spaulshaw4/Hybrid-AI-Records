import { GENRE_RULES } from "@/lib/genre-lock";

/** Studio genre labels. The distribution form uses this list; it is not a free-text field. */
export const DISTRIBUTION_GENRES: readonly string[] = [...new Set(GENRE_RULES.map((rule) => rule.label))].sort((a, b) =>
  a.localeCompare(b, "en"),
);

export const DEFAULT_RECORD_LABEL = "Hybrid AI Records LLC";

/** Minimum square edge. Larger squares are valid. */
export const COVER_MIN_PIXELS = 3000;
export const COVER_PIXELS = COVER_MIN_PIXELS;
export const COVER_MAX_BYTES = 36 * 1024 * 1024;

export const COVER_TOO_LARGE = "Cover art must be under 36 MB.";
export const COVER_NOT_SQUARE = "Cover art must be a square at least 3000 × 3000 pixels.";
export const COVER_NOT_RGB = "Cover art must be RGB. Grayscale and CMYK files are not accepted.";

export const RECORDING_TYPES = [
  "Hybrid Engine Synthesized (Original AI Composition)",
  "Hybrid / AI-Assisted (Human Vocals / Live Instrumentation)",
  "100% Original Human Recording",
] as const;

export type RecordingType = (typeof RECORDING_TYPES)[number];

export const SAMPLE_CLEARANCE_LABEL =
  "I certify this track contains no uncleared commercial samples, unauthorized voice clones, or third-party copyrighted material.";

const COVER_TYPE = "Cover art must be a JPEG or PNG.";
const AUDIO_REQUIRED = "Upload a 16-bit or 24-bit WAV, or a FLAC file.";
const MP3_REJECTED = "MP3 files are not accepted. Upload a 16-bit or 24-bit WAV, or a FLAC file.";
const WAV_DEPTH = "WAV files must be 16-bit or 24-bit.";
const FLAC_INVALID = "That file is not a FLAC.";

export function isDistributionGenre(value: string): boolean {
  return DISTRIBUTION_GENRES.includes(value);
}

export function isRecordingType(value: string): value is RecordingType {
  return (RECORDING_TYPES as readonly string[]).includes(value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let text = "";
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[start + index] ?? 0);
  }
  return text;
}

export function isWav(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

export function isFlac(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && ascii(bytes, 0, 4) === "fLaC";
}

export function wavBitDepth(bytes: Uint8Array): number | null {
  for (let index = 12; index <= bytes.length - 24; index += 1) {
    if (ascii(bytes, index, 4) !== "fmt ") continue;
    return bytes[index + 22]! | (bytes[index + 23]! << 8);
  }
  return null;
}

function isId3(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && ascii(bytes, 0, 3) === "ID3";
}

function looksLikeMp3Frame(bytes: Uint8Array): boolean {
  return bytes.byteLength > 1 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0;
}

export function classifyUploadAudio(
  name: string,
  type: string,
  bytes: Uint8Array,
): { ok: true; kind: "wav" | "flac" } | { ok: false; error: string } {
  const lower = name.toLowerCase();
  const mime = type.toLowerCase().split(";")[0]?.trim() ?? "";
  const mp3Name = lower.endsWith(".mp3") || mime === "audio/mpeg" || mime === "audio/mp3";
  if (mp3Name || isId3(bytes)) return { ok: false, error: MP3_REJECTED };

  const flacNamed = lower.endsWith(".flac") || mime === "audio/flac" || mime === "audio/x-flac";
  if (flacNamed || isFlac(bytes)) {
    if (!isFlac(bytes)) return { ok: false, error: FLAC_INVALID };
    return { ok: true, kind: "flac" };
  }

  const wavNamed =
    lower.endsWith(".wav") || mime === "audio/wav" || mime === "audio/wave" || mime === "audio/x-wav";
  if (wavNamed || isWav(bytes)) {
    if (!isWav(bytes)) return { ok: false, error: AUDIO_REQUIRED };
    const bits = wavBitDepth(bytes);
    if (bits !== 16 && bits !== 24) return { ok: false, error: WAV_DEPTH };
    return { ok: true, kind: "wav" };
  }

  if (looksLikeMp3Frame(bytes)) return { ok: false, error: MP3_REJECTED };
  return { ok: false, error: AUDIO_REQUIRED };
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

type ImageProbe = { width: number; height: number; rgb: boolean };

function pngProbe(bytes: Uint8Array): ImageProbe | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 26) return null;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return null;
  }
  if (ascii(bytes, 12, 4) !== "IHDR") return null;
  const width = readU32BE(bytes, 16);
  const height = readU32BE(bytes, 20);
  if (!width || !height) return null;
  const colorType = bytes[25] ?? 0;
  // 2 = truecolor RGB, 6 = truecolor with alpha. 0/4 are gray, 3 is indexed.
  return { width, height, rgb: colorType === 2 || colorType === 6 };
}

function jpegProbe(bytes: Uint8Array): ImageProbe | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  let width = 0;
  let height = 0;
  let components: number | null = null;
  let adobeTransform: number | null = null;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return width > 0 ? finishJpeg(width, height, components, adobeTransform) : null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    if (marker === undefined) break;
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 1;
      continue;
    }
    if (offset + 2 >= bytes.length) break;
    const length = ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset + 2] ?? 0);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 8 >= bytes.length) return null;
      height = ((bytes[offset + 4] ?? 0) << 8) | (bytes[offset + 5] ?? 0);
      width = ((bytes[offset + 6] ?? 0) << 8) | (bytes[offset + 7] ?? 0);
      components = bytes[offset + 8] ?? 0;
    } else if (marker === 0xee && length >= 14) {
      const start = offset + 3;
      if (ascii(bytes, start, 5) === "Adobe") adobeTransform = bytes[start + 11] ?? null;
    }
    offset += 1 + length;
  }
  if (!width || !height) return null;
  return finishJpeg(width, height, components, adobeTransform);
}

function finishJpeg(
  width: number,
  height: number,
  components: number | null,
  adobeTransform: number | null,
): ImageProbe | null {
  if (!width || !height || components === null) return null;
  // 1 = gray, 4 = CMYK. Adobe transform 2 is YCCK. 3 components is YCbCr/RGB.
  const rgb = components === 3 && adobeTransform !== 2;
  return { width, height, rgb };
}

/**
 * JPEG or PNG, square, at least 3000×3000, under the route's 36 MB cap.
 * Grayscale and CMYK are rejected from the PNG color type and the JPEG
 * component count (including an Adobe APP14 YCCK transform). This check
 * does not decode pixels. A CMYK file the header does not identify is
 * rejected in the browser: the portal draws it to a canvas and refuses
 * the file when RGB pixels cannot be read.
 */
export function classifyCover(
  bytes: Uint8Array,
): { ok: true; kind: "jpeg" | "png"; contentType: "image/jpeg" | "image/png" } | { ok: false; error: string } {
  const png = pngProbe(bytes);
  const jpeg = png ? null : jpegProbe(bytes);
  const size = png ? { kind: "png" as const, ...png } : jpeg ? { kind: "jpeg" as const, ...jpeg } : null;
  if (!size) return { ok: false, error: COVER_TYPE };
  if (!size.rgb) return { ok: false, error: COVER_NOT_RGB };
  if (size.width !== size.height || size.width < COVER_MIN_PIXELS || size.height < COVER_MIN_PIXELS) {
    return { ok: false, error: COVER_NOT_SQUARE };
  }
  return {
    ok: true,
    kind: size.kind,
    contentType: size.kind === "png" ? "image/png" : "image/jpeg",
  };
}
