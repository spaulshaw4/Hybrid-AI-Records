import { audioVaultPublicUrl, vaultAdminClient } from "@/lib/vault-admin.server";
import { readVocalJob } from "@/lib/vocal-jobs.server";

const BUCKET = "audio-vault";
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTaskId(payload: unknown): string {
  if (!isRecord(payload)) return "";
  const direct = readString(payload.task_id);
  if (direct) return direct;
  if (isRecord(payload.data)) return readString(payload.data.task_id);
  return "";
}

function readAudioUrl(payload: unknown): string {
  if (!isRecord(payload)) return "";
  if (isRecord(payload.data)) {
    const nested = readString(payload.data.audio_url);
    if (nested) return nested;
  }
  return readString(payload.audio_url);
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isBlockedHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1" || host === "169.254.169.254") {
    return true;
  }

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (parts.some((part) => part > 255)) return true;
    if (parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }

  const v6 = host.split("%")[0] ?? host;
  if (/^fe[89ab]/i.test(v6)) return true;
  return false;
}

/** https only. Localhost, loopback, and link-local hosts are never fetched. */
function isSafeAudioUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  return !isBlockedHost(parsed.hostname);
}

export async function POST(req: Request): Promise<Response> {
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  const taskId = readTaskId(payload);
  const audioUrl = readAudioUrl(payload);
  if (!taskId || !audioUrl || !TASK_ID.test(taskId) || !isSafeAudioUrl(audioUrl)) {
    return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    const audioRes = await fetch(audioUrl, { redirect: "error" });
    if (!audioRes.ok) {
      console.error("[vocals] audio download failed", audioRes.status);
      return Response.json({ error: "Failed to store audio" }, { status: 500 });
    }
    const declared = Number(audioRes.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      return Response.json({ error: "Invalid webhook payload" }, { status: 400 });
    }
    buffer = Buffer.from(await audioRes.arrayBuffer());
  } catch {
    console.error("[vocals] audio download failed");
    return Response.json({ error: "Failed to store audio" }, { status: 500 });
  }

  if (buffer.byteLength < 1 || buffer.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: "Failed to store audio" }, { status: 500 });
  }

  const objectPath = `vocals/${taskId}.wav`;
  try {
    const supabase = vaultAdminClient();
    const publicUrl = audioVaultPublicUrl(objectPath);
    const upload = await supabase.storage.from(BUCKET).upload(objectPath, buffer, {
      contentType: "audio/wav",
      upsert: true,
    });
    if (upload.error) {
      console.error("[vocals] vault upload failed");
      return Response.json({ error: "Failed to store audio" }, { status: 500 });
    }

    const job = readVocalJob(taskId);
    const userId = job?.userId.trim() ?? "";
    if (!userId) {
      console.warn("[vocals] stored audio without a vault row because the pending job was missing", taskId);
      return Response.json({ received: true });
    }

    const existing = await supabase
      .from("vaulted_tracks")
      .select("task_id")
      .eq("user_id", userId)
      .eq("task_id", taskId)
      .limit(1);
    if (existing.error) {
      console.error("[vocals] vault lookup failed");
      return Response.json({ error: "Failed to store audio" }, { status: 500 });
    }
    const rows = Array.isArray(existing.data) ? existing.data : [];
    if (rows.length > 0) {
      return Response.json({ received: true });
    }

    const inserted = await supabase.from("vaulted_tracks").insert({
      user_id: userId,
      title: job?.title || "Untitled Vocal",
      prompt: job?.tags ?? "",
      lyrics: job?.lyrics ?? "",
      vocal_id_used: job?.personaId?.trim() || null,
      wav_url: publicUrl,
      mp3_url: publicUrl,
      task_id: taskId,
    });
    if (inserted.error) {
      console.error("[vocals] vault insert failed");
      return Response.json({ error: "Failed to store audio" }, { status: 500 });
    }
  } catch {
    console.error("[vocals] vault store failed");
    return Response.json({ error: "Failed to store audio" }, { status: 500 });
  }

  return Response.json({ received: true });
}
