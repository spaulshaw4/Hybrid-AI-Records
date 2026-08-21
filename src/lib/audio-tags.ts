/**
 * Client-side audio tagging.
 *
 * Downloaded masters come straight from the generation CDN with no metadata,
 * so music players show the raw filename. These helpers stamp title/artist
 * into the bytes before the browser saves the file: ID3v2.3 for MP3 and a
 * RIFF LIST/INFO chunk for WAV.
 */

export type AudioTags = { title?: string; artist?: string };

const SOFTWARE = "Hybrid Engine 1.0";

/**
 * Normalizes a title/artist for embedding: collapses whitespace (including
 * newlines and tabs) and strips control characters that break tag readers.
 */
export function sanitizeTagText(value: string | undefined, max = 120): string {
  if (!value) return "";
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Normalizes a title/artist for use inside a filename: sanitized text with
 * characters illegal on Windows/macOS removed and spaces turned into hyphens.
 */
export function sanitizeFileNamePart(value: string | undefined, fallback = ""): string {
  const cleaned = sanitizeTagText(value, 80)
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/[^\w\s.-]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function encodeText(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** ID3v2 sizes are 7 bits per byte ("synchsafe"). */
function synchsafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
}

function id3Frame(id: string, value: string): Uint8Array {
  const text = encodeText(value);
  // 0x03 = UTF-8 encoding flag, then the text, then a terminating null.
  const body = new Uint8Array(1 + text.length + 1);
  body[0] = 0x03;
  body.set(text, 1);

  const frame = new Uint8Array(10 + body.length);
  for (let i = 0; i < 4; i += 1) frame[i] = id.charCodeAt(i);
  const size = body.length;
  frame[4] = (size >>> 24) & 0xff;
  frame[5] = (size >>> 16) & 0xff;
  frame[6] = (size >>> 8) & 0xff;
  frame[7] = size & 0xff;
  frame.set(body, 10);
  return frame;
}

/** Builds a complete ID3v2.3 tag block for the given metadata. */
export function buildId3v2(tags: AudioTags): Uint8Array {
  const frames: Uint8Array[] = [];
  const title = sanitizeTagText(tags.title);
  const artist = sanitizeTagText(tags.artist);
  if (title) frames.push(id3Frame("TIT2", title));
  if (artist) frames.push(id3Frame("TPE1", artist));
  frames.push(id3Frame("TSSE", SOFTWARE));

  const bodyLength = frames.reduce((total, f) => total + f.length, 0);
  const tag = new Uint8Array(10 + bodyLength);
  tag.set([0x49, 0x44, 0x33, 0x03, 0x00, 0x00], 0); // "ID3" v2.3, no flags
  tag.set(synchsafe(bodyLength), 6);

  let offset = 10;
  for (const frame of frames) {
    tag.set(frame, offset);
    offset += frame.length;
  }
  return tag;
}

/** Removes an existing ID3v2 tag so we never stack duplicates. */
function stripId3v2(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 10) return bytes;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return bytes;
  const size =
    ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return bytes.subarray(10 + size);
}

/** Builds a RIFF LIST/INFO chunk carrying title (INAM) and artist (IART). */
export function buildRiffInfoChunk(tags: AudioTags): Uint8Array {
  const fields: Array<[string, string]> = [];
  const title = sanitizeTagText(tags.title);
  const artist = sanitizeTagText(tags.artist);
  if (title) fields.push(["INAM", title]);
  if (artist) fields.push(["IART", artist]);
  fields.push(["ISFT", SOFTWARE]);

  const entries = fields.map(([id, value]) => {
    const text = encodeText(`${value}\0`);
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

function tagWavBytes(bytes: Uint8Array, tags: AudioTags): Blob {
  const header = new DataView(bytes.buffer, bytes.byteOffset, Math.min(12, bytes.byteLength));
  const isRiff =
    bytes.length > 12 && header.getUint8(0) === 0x52 && header.getUint8(1) === 0x49 && header.getUint8(2) === 0x46;
  if (!isRiff) return new Blob([bytes as unknown as ArrayBuffer], { type: "audio/wav" });

  const info = buildRiffInfoChunk(tags);
  const copy = bytes.slice();
  const view = new DataView(copy.buffer);
  // Grow the RIFF size to account for the appended LIST/INFO chunk.
  view.setUint32(4, view.getUint32(4, true) + info.length, true);
  return new Blob([copy as unknown as ArrayBuffer, info as unknown as ArrayBuffer], { type: "audio/wav" });
}

/**
 * Returns a copy of the audio blob with title/artist metadata embedded.
 * Falls back to the original blob if the format is unknown or tagging fails.
 */
export async function tagAudioBlob(blob: Blob, format: "mp3" | "wav", tags: AudioTags): Promise<Blob> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (format === "wav") return tagWavBytes(bytes, tags);
    const audio = stripId3v2(bytes);
    const tag = buildId3v2(tags);
    return new Blob([tag as unknown as ArrayBuffer, audio.slice() as unknown as ArrayBuffer], { type: "audio/mpeg" });
  } catch {
    return blob;
  }
}
