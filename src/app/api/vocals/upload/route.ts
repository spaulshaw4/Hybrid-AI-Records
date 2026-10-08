import { resolveStudioSession, UnauthorizedSessionError } from "@/lib/studio-request-auth.server";
import { audioVaultPublicUrl, vaultAdminClient } from "@/lib/vault-admin.server";

const MAX_VOCAL_BYTES = 15 * 1024 * 1024;
const BUCKET = "audio-vault";

type StoredAudio = {
  ext: "wav" | "webm" | "ogg" | "mp3" | "m4a";
  contentType: string;
};

function isUnauthorized(err: unknown): boolean {
  if (err instanceof UnauthorizedSessionError) return true;
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

function hasBearer(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim().length > 0;
}

function findSequence(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0 || haystack.length < needle.length) return -1;
  outer: for (let index = from; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

type MultipartAudio = { bytes: Uint8Array; type: string };

/** Reads the audio part without relying on a cross-realm File from formData(). */
async function readMultipartAudio(req: Request): Promise<MultipartAudio | "missing" | "invalid"> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) return "invalid";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  if (!boundary) return "invalid";

  const raw = new Uint8Array(await req.arrayBuffer());
  const encoder = new TextEncoder();
  const opening = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const headerBreak = encoder.encode("\r\n\r\n");
  let cursor = findSequence(raw, opening);
  if (cursor < 0) return "invalid";
  cursor += opening.length;
  if (raw[cursor] === 45 && raw[cursor + 1] === 45) return "missing";
  if (raw[cursor] === 13 && raw[cursor + 1] === 10) cursor += 2;

  while (cursor < raw.length) {
    const next = findSequence(raw, delimiter, cursor);
    const part = next < 0 ? raw.subarray(cursor) : raw.subarray(cursor, next);
    const headerEnd = findSequence(part, headerBreak);
    if (headerEnd >= 0) {
      const headerText = new TextDecoder().decode(part.subarray(0, headerEnd));
      if (/name="(?:audio|file|vocal)"/i.test(headerText)) {
        const type = /content-type:\s*([^\r\n;]+)/i.exec(headerText)?.[1]?.trim() ?? "";
        return { bytes: part.subarray(headerEnd + headerBreak.length), type };
      }
    }
    if (next < 0) break;
    cursor = next + delimiter.length;
    if (raw[cursor] === 45 && raw[cursor + 1] === 45) break;
    if (raw[cursor] === 13 && raw[cursor + 1] === 10) cursor += 2;
  }
  return "missing";
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Bytes decide the object extension. A declared WAV type never relabels other audio. */
function sniffAudio(bytes: Uint8Array, declaredType: string): StoredAudio | null {
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)) {
    return { ext: "wav", contentType: "audio/wav" };
  }
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { ext: "webm", contentType: "audio/webm" };
  }
  if (startsWith(bytes, [0x4f, 0x67, 0x67, 0x53])) {
    return { ext: "ogg", contentType: "audio/ogg" };
  }
  if (startsWith(bytes, [0x49, 0x44, 0x33]) || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) {
    return { ext: "mp3", contentType: "audio/mpeg" };
  }
  if (startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4)) {
    return { ext: "m4a", contentType: "audio/mp4" };
  }

  const declared = declaredType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (declared === "audio/webm") return { ext: "webm", contentType: "audio/webm" };
  if (declared === "audio/ogg") return { ext: "ogg", contentType: "audio/ogg" };
  if (declared === "audio/mpeg" || declared === "audio/mp3") return { ext: "mp3", contentType: "audio/mpeg" };
  if (declared === "audio/mp4") return { ext: "m4a", contentType: "audio/mp4" };
  return null;
}

export async function POST(req: Request): Promise<Response> {
  if (!hasBearer(req)) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let userId = "";
  try {
    const session = await resolveStudioSession(req);
    userId = session.userId.trim();
  } catch (err: unknown) {
    if (!isUnauthorized(err)) console.error("[vocals] session failed");
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }
  if (!userId || userId === "guest_user" || userId.includes("/") || userId.includes("\\") || userId.includes("..")) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let audio: MultipartAudio | "missing" | "invalid";
  try {
    audio = await readMultipartAudio(req);
  } catch {
    return Response.json({ error: "Audio file is required." }, { status: 400 });
  }
  if (audio === "invalid" || audio === "missing") {
    return Response.json({ error: "Audio file is required." }, { status: 400 });
  }
  if (audio.bytes.byteLength <= 0) {
    return Response.json({ error: "Audio file is empty." }, { status: 400 });
  }
  if (audio.bytes.byteLength > MAX_VOCAL_BYTES) {
    return Response.json({ error: "That vocal take is too large." }, { status: 413 });
  }

  const bytes = audio.bytes;
  const sniffed = sniffAudio(bytes, audio.type);
  if (!sniffed) {
    return Response.json({ error: "Upload an audio file." }, { status: 400 });
  }

  const fileName = `voice-take-${Date.now()}.${sniffed.ext}`;
  const objectPath = `vocal-references/${userId}/${fileName}`;

  try {
    const admin = vaultAdminClient();
    const { error } = await admin.storage.from(BUCKET).upload(objectPath, bytes, {
      contentType: sniffed.contentType,
      upsert: false,
    });
    if (error) {
      console.error("[vocals] reference upload failed");
      return Response.json({ error: "Could not save this vocal take." }, { status: 500 });
    }
  } catch {
    console.error("[vocals] reference upload failed");
    return Response.json({ error: "Could not save this vocal take." }, { status: 500 });
  }

  return Response.json({ url: audioVaultPublicUrl(objectPath), fileName });
}
