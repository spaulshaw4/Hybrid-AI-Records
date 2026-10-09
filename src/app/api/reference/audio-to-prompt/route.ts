import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { vaultAdminClient } from "@/lib/vault-admin.server";

/** Official model inputs include prompt and a single audio URI. */
const PREDICT_URL = "https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
/** No temp-audio bucket is configured. Masters already live in audio-vault. */
const AUDIO_BUCKET = "audio-vault";

const ANALYSIS_PROMPT = `Listen to this master audio track closely.
Extract its core acoustic and production DNA.
Return ONLY valid JSON matching this schema:
{
  "tags": "BPM, key musical key, primary instrumentation, rhythmic groove, vocal texture (max 100 characters)"
}`;

function isWebmEbml(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
}

function isRiffWav(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function isMpegAudio(buffer: Buffer): boolean {
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") return true;
  return buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function textFromOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return "";
  return output.map((part) => (typeof part === "string" ? part : "")).join("");
}

function stripJsonFence(raw: string): string {
  const text = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function tagsFromOutput(output: unknown): string {
  try {
    const parsed: unknown = JSON.parse(stripJsonFence(textFromOutput(output)));
    if (!parsed || typeof parsed !== "object") return "";
    const tags = (parsed as { tags?: unknown }).tags;
    return typeof tags === "string" ? tags.trim() : "";
  } catch {
    return "";
  }
}

function publicHttpsUrl(raw: string): string {
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  parsed.searchParams.delete("token");
  parsed.search = parsed.searchParams.toString();
  const url = parsed.toString();
  if (parsed.protocol !== "https:" || url.includes("token=")) return "";
  if (!url.includes("/audio-vault/references/")) return "";
  return url;
}

/** Keep the session path, and force the extension from the byte sniff. */
function storageObjectName(originalName: string, extension: "wav" | "mp3"): string {
  const suffix = `.${extension}`;
  const fallback = `reference${suffix}`;
  const sanitized = (originalName.trim() || fallback).replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized.endsWith(suffix) && sanitized.length > suffix.length) return sanitized;
  const stem = sanitized.replace(/\.[A-Za-z0-9]+$/i, "").replace(/\.+$/g, "");
  return `${stem || "reference"}${suffix}`;
}

function failed(): Response {
  console.error("[audio-to-prompt] error");
  return Response.json({ error: "Failed to analyze audio" }, { status: 500 });
}

/**
 * POST /api/reference/audio-to-prompt
 * Session bearer required. A form userId is ignored.
 * The sniffed bytes are stored in audio-vault and the public https URL is sent as audio.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !authorization.slice("Bearer ".length).trim()) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let userId = "";
    try {
      const session = await resolveStudioSession(req);
      userId = session.userId.trim();
    } catch {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const formData = await req.formData();
    const uploaded = formData.get("file");
    if (!(uploaded instanceof Blob)) {
      return Response.json({ error: "Missing audio file" }, { status: 400 });
    }
    if (uploaded.size <= 0 || uploaded.size > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }

    const arrayBuffer = await uploaded.arrayBuffer();
    const uploadBytes = Buffer.from(arrayBuffer);
    if (uploadBytes.length <= 0 || uploadBytes.length > MAX_REFERENCE_BYTES) {
      return Response.json({ error: "File empty or exceeds 50MB limit" }, { status: 400 });
    }
    if (isWebmEbml(uploadBytes) || (!isRiffWav(uploadBytes) && !isMpegAudio(uploadBytes))) {
      return Response.json({ error: "Reference audio must be a WAV file." }, { status: 400 });
    }

    const token = process.env.REPLICATE_API_TOKEN?.trim() ?? "";
    if (!token) return failed();

    const wav = isRiffWav(uploadBytes);
    const contentType = wav ? "audio/wav" : "audio/mpeg";
    const extension = wav ? "wav" : "mp3";
    const filename =
      uploaded instanceof File && uploaded.name.trim() ? uploaded.name.trim() : `reference.${extension}`;
    const storagePath = `references/${userId}/${Date.now()}-${storageObjectName(filename, extension)}`;

    let admin: ReturnType<typeof vaultAdminClient>;
    try {
      admin = vaultAdminClient();
    } catch {
      return failed();
    }

    const { error: uploadError } = await admin.storage.from(AUDIO_BUCKET).upload(storagePath, uploadBytes, {
      contentType,
      upsert: true,
    });
    if (uploadError) return failed();

    const { data } = admin.storage.from(AUDIO_BUCKET).getPublicUrl(storagePath);
    const audioUrl = publicHttpsUrl(typeof data?.publicUrl === "string" ? data.publicUrl : "");
    if (!audioUrl) return failed();

    let upstream: Response;
    try {
      upstream = await fetch(PREDICT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          input: {
            prompt: ANALYSIS_PROMPT,
            audio: audioUrl,
          },
        }),
      });
    } catch {
      return failed();
    }

    let payload: { status?: unknown; output?: unknown } = {};
    try {
      const parsed: unknown = await upstream.json();
      if (parsed && typeof parsed === "object") payload = parsed as { status?: unknown; output?: unknown };
    } catch {
      return failed();
    }

    const tags = tagsFromOutput(payload.output);
    if (!upstream.ok || payload.status !== "succeeded" || !tags) return failed();
    return Response.json({ success: true, tags, filename });
  } catch {
    return failed();
  }
}
