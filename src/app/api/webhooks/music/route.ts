import { createHmac, timingSafeEqual } from "node:crypto";

import { audioVaultPublicUrl, vaultAdminClient } from "@/lib/vault-admin.server";
import { readVocalJob } from "@/lib/vocal-jobs.server";

const BUCKET = "audio-vault";
const MAX_AUDIO_BYTES = 40 * 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REPLAY_WINDOW_SECONDS = 300;

type AdminClient = ReturnType<typeof vaultAdminClient>;
type SignatureVerdict = "ok" | "malformed" | "mismatch";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readTaskId(payload: Record<string, unknown>): string {
  const direct = readString(payload.task_id);
  if (direct) return direct;
  if (isRecord(payload.data)) return readString(payload.data.task_id);
  return "";
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

function verifySignature(secret: string, timestamp: string, rawBody: string, signatureHeader: string): SignatureVerdict {
  const provided = signatureHeader.trim().replace(/^sha256=/i, "");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  if (!/^[0-9a-fA-F]+$/.test(provided) || provided.length % 2 !== 0) return "malformed";

  const providedMac = Buffer.from(provided, "hex");
  const expectedMac = Buffer.from(expected, "hex");
  if (providedMac.length !== expectedMac.length) return "malformed";
  if (!timingSafeEqual(providedMac, expectedMac)) return "mismatch";
  return "ok";
}

function failureDetail(payload: Record<string, unknown>): string {
  const candidates = [payload.error_message, payload.error, payload.message, payload.msg];
  for (const candidate of candidates) {
    const text = readString(candidate);
    if (text) return text.slice(0, 500);
  }
  if (isRecord(payload.data)) {
    const nested = readString(payload.data.error) || readString(payload.data.message);
    if (nested) return nested.slice(0, 500);
  }
  return "failed";
}

function isFailedEvent(payload: Record<string, unknown>): boolean {
  if (readString(payload.event) === "song.failed") return true;
  if (!Object.prototype.hasOwnProperty.call(payload, "code")) return false;
  return payload.code !== 200;
}

function personaRecord(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(payload.data)) return null;
  if (!readString(payload.data.persona_id)) return null;
  return payload.data;
}

function processingError(err: unknown): Response {
  console.error("[webhook] Processing error:", err);
  const message = err instanceof Error && err.message ? err.message : "Internal error";
  return Response.json({ error: message }, { status: 500 });
}

async function markFailed(payload: Record<string, unknown>): Promise<Response> {
  const taskId = readTaskId(payload);
  const detail = failureDetail(payload);
  console.error(`[webhook] Task ${taskId || "unknown"} failed:`, detail);

  if (!taskId) {
    return Response.json({ status: "ok", received: "failed_logged" });
  }

  const supabase = vaultAdminClient();
  const updatedAt = new Date().toISOString();
  const persona = await supabase
    .from("vocal_personas")
    .update({
      status: "failed",
      error_message: detail,
      updated_at: updatedAt,
    })
    .eq("task_id", taskId);
  if (persona.error) {
    console.error("[webhook] vocal persona failure update failed");
  }

  return Response.json({ status: "ok", received: "failed_logged" });
}

async function markPersonaReady(payload: Record<string, unknown>, data: Record<string, unknown>): Promise<Response> {
  const personaId = readString(data.persona_id).slice(0, 128);
  const name = (readString(data.name) || "Custom Take").slice(0, 200);
  console.log(`[webhook:voice] Persona created: ${personaId} (${name})`);

  const taskId = readTaskId(payload);
  if (!taskId) {
    console.error("[webhook] persona callback missing task_id");
    return Response.json({ status: "ok", type: "persona_ready" });
  }

  const supabase = vaultAdminClient();
  const updated = await supabase
    .from("vocal_personas")
    .update({
      persona_id: personaId,
      persona_name: name,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("task_id", taskId);
  if (updated.error) {
    console.error("[webhook] vocal persona update failed");
    return Response.json({ error: "DB write failed" }, { status: 500 });
  }
  console.log("[webhook] vocal persona updated");

  return Response.json({ status: "ok", type: "persona_ready" });
}

function clipTitle(clip: Record<string, unknown>, index: number, total: number, fallback: string): string {
  const base = readString(clip.title) || fallback || "Untitled Track";
  return total > 1 ? `${base} (${index + 1})` : base;
}

async function titlesFor(supabase: AdminClient, table: "vaulted_tracks", userId: string, taskId: string): Promise<Set<string>> {
  const existing = await supabase.from(table).select("title").eq("user_id", userId).eq("task_id", taskId);
  if (existing.error) {
    console.error("[webhook] vault lookup failed:", { table, userId, taskId, error: existing.error });
    throw new Error("Internal error");
  }
  const rows = Array.isArray(existing.data) ? existing.data : [];
  return new Set(rows.map((row) => (isRecord(row) ? readString(row.title) : "")).filter(Boolean));
}

async function resolveOwner(supabase: AdminClient, taskId: string): Promise<{ userId: string; personaId: string }> {
  const job = readVocalJob(taskId);
  let userId = job?.userId.trim() ?? "";
  let personaId = job?.personaId?.trim() ?? "";
  if (userId && personaId) return { userId, personaId };

  const lookup = await supabase.from("vocal_personas").select("user_id, persona_id").eq("task_id", taskId).limit(1);
  if (lookup.error) {
    console.error("[webhook] persona lookup failed");
    throw new Error("Internal error");
  }
  const row = Array.isArray(lookup.data) ? lookup.data[0] : null;
  if (isRecord(row)) {
    if (!userId) userId = readString(row.user_id);
    if (!personaId) personaId = readString(row.persona_id);
  }
  return { userId, personaId };
}

async function storeMaster(
  supabase: AdminClient,
  objectPath: string,
  audioUrl: string,
): Promise<{ ok: true; publicUrl: string } | { ok: false; status: number; error: string }> {
  if (!isSafeAudioUrl(audioUrl)) {
    return { ok: false, status: 400, error: "Invalid webhook payload" };
  }

  let buffer: Buffer;
  try {
    const audioRes = await fetch(audioUrl, { redirect: "error" });
    if (!audioRes.ok) {
      console.error("[webhook] audio download failed", audioRes.status);
      return { ok: false, status: 500, error: "Failed to store audio" };
    }
    const declared = Number(audioRes.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      return { ok: false, status: 400, error: "Invalid webhook payload" };
    }
    buffer = Buffer.from(await audioRes.arrayBuffer());
  } catch {
    console.error("[webhook] audio download failed");
    return { ok: false, status: 500, error: "Failed to store audio" };
  }

  if (buffer.byteLength < 1 || buffer.byteLength > MAX_AUDIO_BYTES) {
    return { ok: false, status: 500, error: "Failed to store audio" };
  }

  const upload = await supabase.storage.from(BUCKET).upload(objectPath, buffer, {
    contentType: "audio/wav",
    upsert: true,
  });
  if (upload.error) {
    console.error("[webhook] vault upload failed");
    return { ok: false, status: 500, error: "Failed to store audio" };
  }

  return { ok: true, publicUrl: audioVaultPublicUrl(objectPath) };
}

async function storeCompletedSong(payload: Record<string, unknown>): Promise<Response> {
  const taskId = readTaskId(payload);
  const data = Array.isArray(payload.data) ? payload.data : [];
  const clips = data.filter(isRecord).filter((clip) => readString(clip.state) === "succeeded");
  if (!TASK_ID.test(taskId) || clips.length === 0) {
    return Response.json({ status: "ok", type: "music_ready" });
  }

  const supabase = vaultAdminClient();
  const owner = await resolveOwner(supabase, taskId);
  if (!owner.userId) {
    console.warn("[webhook] song completed without a known user", taskId);
    return Response.json({ status: "ok", type: "music_ready" });
  }

  const job = readVocalJob(taskId);
  const vaultTitles = await titlesFor(supabase, "vaulted_tracks", owner.userId, taskId);

  for (let index = 0; index < clips.length; index += 1) {
    const clip = clips[index] ?? {};
    const audioUrl = readString(clip.audio_url);
    if (!isSafeAudioUrl(audioUrl)) continue;

    const title = clipTitle(clip, index, clips.length, job?.title ?? "");
    if (vaultTitles.has(title)) continue;

    const objectPath = index === 0 ? `vocals/${taskId}.wav` : `vocals/${taskId}-${index}.wav`;
    const stored = await storeMaster(supabase, objectPath, audioUrl);
    if (!stored.ok) return Response.json({ error: stored.error }, { status: stored.status });
    const publicUrl = stored.publicUrl;

    const prompt = readString(clip.prompt) || readString(clip.tags) || job?.tags || "";
    const lyrics = readString(clip.lyrics) || readString(clip.lyric) || job?.lyrics || "";

    const inserted = await supabase.from("vaulted_tracks").insert({
      user_id: owner.userId,
      title,
      prompt,
      lyrics,
      vocal_id_used: owner.personaId || null,
      wav_url: publicUrl,
      mp3_url: publicUrl,
      task_id: taskId,
    });
    if (inserted.error) {
      console.error("[webhook] vault insert failed:", inserted.error);
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
    vaultTitles.add(title);
  }

  return Response.json({ status: "ok", type: "music_ready" });
}

async function handleVerified(payload: unknown): Promise<Response> {
  if (!isRecord(payload)) {
    return Response.json({ status: "ok", received: "unhandled_state" });
  }
  if (isFailedEvent(payload)) return markFailed(payload);

  const persona = personaRecord(payload);
  if (persona) return markPersonaReady(payload, persona);

  if (Array.isArray(payload.data) && readString(payload.event) === "song.completed") {
    return storeCompletedSong(payload);
  }

  return Response.json({ status: "ok", received: "unhandled_state" });
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.AIMUSICAPI_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[webhook] AIMUSICAPI_WEBHOOK_SECRET is not configured");
    return Response.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const timestamp = req.headers.get("x-webhook-timestamp");
  const signature = req.headers.get("x-webhook-signature");
  if (!timestamp || !signature) {
    return Response.json({ error: "Missing signature headers" }, { status: 400 });
  }

  const timestampSeconds = Number(timestamp);
  const age = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (!Number.isFinite(timestampSeconds) || age > REPLAY_WINDOW_SECONDS) {
    return Response.json({ error: "Timestamp expired or invalid" }, { status: 401 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    return processingError(err);
  }

  const verdict = verifySignature(secret, timestamp, rawBody, signature);
  if (verdict === "malformed") {
    return Response.json({ error: "Malformed signature hex" }, { status: 401 });
  }
  if (verdict === "mismatch") {
    console.warn("[webhook] HMAC signature mismatch");
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  try {
    return await handleVerified(payload);
  } catch (err) {
    return processingError(err);
  }
}
