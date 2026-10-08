import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { vaultAdminClient } from "@/lib/vault-admin.server";

const MAX_VOCAL_BYTES = 15 * 1024 * 1024;
const CREATE_VOICE_URL = "https://api.aimusicapi.ai/api/v1/sonic/create-voice";
const VOICE_WEBHOOK_URL = "https://hybrid-ai-records.com/api/webhooks/music";
const REGISTER_ERROR = "Could not register this vocal take.";
const UNSUPPORTED_AUDIO = "Vocal take must be WAV or MPEG audio.";
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

type VocalAudio = { contentType: "audio/wav" | "audio/mpeg"; extension: "wav" | "mp3" };

/** Matroska/WebM starts with the EBML magic. Storage and Sonic both reject it. */
function isWebmEbml(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3;
}

/** RIFF/WAVE, or MPEG (frame sync 0xFFEx / 0xFFFx, or an ID3 header). WebM is never a match. */
function sniffVocalAudio(buffer: Buffer): VocalAudio | null {
  if (isWebmEbml(buffer)) return null;
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    return { contentType: "audio/wav", extension: "wav" };
  }
  const id3 = buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3";
  const frame = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0;
  if (id3 || frame) return { contentType: "audio/mpeg", extension: "mp3" };
  return null;
}

type VaultAdmin = ReturnType<typeof vaultAdminClient>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function taskIdFromVoice(body: unknown): string {
  if (!isRecord(body)) return "";
  const direct = readString(body.task_id);
  if (direct) return direct;
  if (isRecord(body.data)) return readString(body.data.task_id);
  return "";
}

/** Drop a token query only on the public object URL. Signed URLs are left unchanged. */
function stripPublicObjectToken(raw: string): string {
  if (!raw) return "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (!parsed.pathname.includes("/storage/v1/object/public/")) return raw;
  if (!parsed.searchParams.has("token")) return raw;
  parsed.searchParams.delete("token");
  parsed.search = parsed.searchParams.toString();
  return parsed.toString();
}

async function registerVocalTake(
  admin: VaultAdmin,
  publicUrl: string,
  userId: string,
): Promise<{ ok: true; taskId: string } | { ok: false }> {
  const apiKey = (process.env.AIMUSIC_API_KEY || process.env.AIMUSICAPI_KEY || "").trim();
  const webhookSecret = process.env.AIMUSICAPI_WEBHOOK_SECRET;
  if (!apiKey || !webhookSecret?.trim()) {
    console.error("[vocals] vocal take registration is not configured");
    return { ok: false };
  }

  try {
    const response = await fetch(CREATE_VOICE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        audio_url: publicUrl,
        webhook_url: VOICE_WEBHOOK_URL,
        webhook_secret: webhookSecret,
      }),
    });
    if (!response.ok) {
      console.error("[vocals] vocal take registration failed", response.status);
      return { ok: false };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const taskId = taskIdFromVoice(body);
    if (!taskId || !TASK_ID.test(taskId)) {
      console.error("[vocals] vocal take registration returned no task id");
      return { ok: false };
    }

    const inserted = await admin.from("vocal_personas").insert({
      task_id: taskId,
      user_id: userId,
      status: "processing",
      audio_url: publicUrl,
      updated_at: new Date().toISOString(),
    });
    if (inserted.error) {
      console.error("[vocals] vocal persona insert failed");
      return { ok: false };
    }
    return { ok: true, taskId };
  } catch {
    console.error("[vocals] vocal take registration failed");
    return { ok: false };
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const authorization = req.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let user: { id: string };
    try {
      const session = await resolveStudioSession(req);
      const id = session.userId.trim();
      if (!id) return Response.json({ error: "Invalid session" }, { status: 401 });
      user = { id };
    } catch {
      return Response.json({ error: "Invalid session" }, { status: 401 });
    }

    const formData = await req.formData();
    const file = formData.get("audio");
    if (!(file instanceof Blob)) {
      return Response.json({ error: "No audio file provided" }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0 || buffer.length > MAX_VOCAL_BYTES) {
      return Response.json({ error: "File empty or exceeds 15MB limit" }, { status: 400 });
    }

    if (isWebmEbml(buffer)) {
      return Response.json({ error: UNSUPPORTED_AUDIO }, { status: 400 });
    }
    const sniffed = sniffVocalAudio(buffer);
    if (!sniffed) {
      return Response.json({ error: UNSUPPORTED_AUDIO }, { status: 400 });
    }
    const contentType = sniffed.extension === "wav" ? "audio/wav" : "audio/mpeg";
    const fileName = `voice-take-${Date.now()}.${sniffed.extension}`;
    const storagePath = `vocal-references/${user.id}/${fileName}`;
    const uploadBytes = Buffer.from(buffer);

    const admin = vaultAdminClient();
    const { error: uploadError } = await admin.storage.from("audio-vault").upload(storagePath, uploadBytes, {
      contentType,
      upsert: true,
    });
    if (uploadError) {
      try {
        console.error("[vocals] reference upload failed:", uploadError.message, JSON.stringify(uploadError, null, 2));
      } catch {
        console.error("[vocals] reference upload failed:", uploadError.message, uploadError);
      }
      return Response.json({ error: uploadError.message }, { status: 500 });
    }

    const { data } = admin.storage.from("audio-vault").getPublicUrl(storagePath);
    const publicUrl = stripPublicObjectToken(typeof data?.publicUrl === "string" ? data.publicUrl : "");
    if (!publicUrl) {
      console.error("[vocals] public vocal url missing");
      return Response.json({ error: REGISTER_ERROR }, { status: 502 });
    }

    const registered = await registerVocalTake(admin, publicUrl, user.id);
    if (!registered.ok) {
      return Response.json({ error: REGISTER_ERROR }, { status: 502 });
    }
    return Response.json({ url: publicUrl, fileName, taskId: registered.taskId }, { status: 200 });
  } catch (err: unknown) {
    console.error("[vocals] unexpected route exception:", err);
    if (err instanceof Error) {
      return Response.json({ error: err.message || "Internal server error" }, { status: 500 });
    }
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}
