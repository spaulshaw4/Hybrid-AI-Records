import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { dispatchReleaseToTooLost } from "@/lib/too-lost/dispatch";
import { AuthRequiredError } from "@/lib/too-lost/errors";
import { resolveStudioSession, UnauthorizedSessionError } from "@/lib/studio-request-auth.server";

const MAX_WAV_BYTES = 200 * 1024 * 1024;
const INSUFFICIENT = "You need 1 D-Token to distribute a release.";
const VENDOR_FAILURE = "Too Lost could not accept this release. Nothing was charged.";
const CHARGE_INCOMPLETE =
  "Too Lost accepted the release, but the D-Token could not be charged. Contact support before submitting again.";

type AdminClient = SupabaseClient;

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

/**
 * Portal D-Token balance. `profiles` has no `d_tokens` column.
 * The studio already stores Hybrid Tokens on `token_balances.balance`
 * and debits them with `spend_hybrid_tokens`.
 */
function adminClient(): AdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Supabase is not configured");
  return createClient(url, key);
}

async function readBalance(supabase: AdminClient, userId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("token_balances")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return typeof data?.balance === "number" ? data.balance : 0;
}

function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const wave = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  return riff === "RIFF" && wave === "WAVE";
}

function safeWavName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "track.wav";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  if (!cleaned) return "track.wav";
  return cleaned.toLowerCase().endsWith(".wav") ? cleaned : `${cleaned}.wav`;
}

type UploadFile = {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
};

type ReleaseForm = {
  fields: Map<string, string>;
  audio: UploadFile | null;
};

function field(fields: Map<string, string>, name: string): string {
  return (fields.get(name) ?? "").trim();
}

function findBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  for (let index = from; index <= hay.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (hay[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

/**
 * Reads multipart form data from the raw body.
 * jsdom's Request.formData() rejects undici File parts, so the route does not use it.
 */
async function readReleaseForm(req: Request): Promise<ReleaseForm | null> {
  const contentType = req.headers.get("content-type") ?? "";
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || "").trim();
  if (!boundary) return null;
  const body = new Uint8Array(await req.arrayBuffer());
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const headerBreak = encoder.encode("\r\n\r\n");
  const fields = new Map<string, string>();
  let audio: UploadFile | null = null;
  let cursor = 0;
  while (cursor < body.length) {
    const start = findBytes(body, delimiter, cursor);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;
    const next = findBytes(body, delimiter, partStart);
    if (next < 0) break;
    let partEnd = next;
    if (partEnd >= 2 && body[partEnd - 2] === 13 && body[partEnd - 1] === 10) partEnd -= 2;
    const part = body.subarray(partStart, partEnd);
    const split = findBytes(part, headerBreak, 0);
    if (split >= 0) {
      const headerText = new TextDecoder().decode(part.subarray(0, split));
      const data = part.subarray(split + headerBreak.length);
      const name = /name="([^"]*)"/.exec(headerText)?.[1] ?? "";
      const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
      const type = /content-type:\s*([^\r\n]+)/i.exec(headerText)?.[1]?.trim() ?? "";
      if (name && filename !== undefined) {
        const bytes = new Uint8Array(data);
        audio = { name: filename || "track.wav", type, size: bytes.byteLength, bytes };
      } else if (name) {
        fields.set(name, new TextDecoder().decode(data).replace(/\r\n$/, ""));
      }
    }
    cursor = next;
  }
  return { fields, audio };
}

function ownedStorageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!base) return null;
  let allowed: URL;
  try {
    allowed = new URL(base);
  } catch {
    return null;
  }
  if (url.host !== allowed.host) return null;
  if (!url.pathname.includes("/storage/v1/object/")) return null;
  return url.toString();
}

async function wavFromVault(supabase: AdminClient, userId: string, vaultTrackId: string): Promise<{
  bytes: Uint8Array;
  fileName: string;
} | Response> {
  const { data, error } = await supabase
    .from("vaulted_tracks")
    .select("id, title, wav_url, user_id")
    .eq("id", vaultTrackId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !data || data.user_id !== userId) {
    return Response.json({ error: "Choose one of your mastered tracks." }, { status: 400 });
  }
  const href = ownedStorageUrl(typeof data.wav_url === "string" ? data.wav_url : "");
  if (!href) {
    return Response.json({ error: "That mastered track has no WAV on file." }, { status: 400 });
  }
  const audio = await fetch(href);
  if (!audio.ok) {
    return Response.json({ error: "Could not read that mastered track." }, { status: 400 });
  }
  const bytes = new Uint8Array(await audio.arrayBuffer());
  if (bytes.byteLength > MAX_WAV_BYTES || !isWav(bytes)) {
    return Response.json({ error: "That mastered track is not a WAV we can send." }, { status: 400 });
  }
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "track";
  return { bytes, fileName: safeWavName(`${title}.wav`) };
}

/**
 * POST /api/distribute/too-lost
 * Session user id is the only trusted user id. Body userId is ignored.
 * Balance is `token_balances.balance`. One token is spent only after Too Lost accepts the release.
 */
export async function POST(req: Request): Promise<Response> {
  if (!hasBearer(req)) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let userId = "";
  try {
    const session = await resolveStudioSession(req);
    userId = session.userId.trim();
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    console.error("[distribute] session failed");
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }
  if (!userId || userId === "guest_user") {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  const form = await readReleaseForm(req);
  if (!form) {
    return Response.json({ error: "Send the release as form data." }, { status: 400 });
  }

  const title = field(form.fields, "title").slice(0, 200);
  const artist = field(form.fields, "artist").slice(0, 200);
  const source = field(form.fields, "source");
  const vaultTrackId = field(form.fields, "vaultTrackId");
  const acceptTerms = field(form.fields, "acceptTerms") === "true";
  const confirmRights = field(form.fields, "confirmRights") === "true";
  const instrumental = field(form.fields, "instrumental") === "true";
  const explicit = field(form.fields, "explicit") === "true";
  const language = field(form.fields, "language") || "en";

  if (!title || !artist) {
    return Response.json({ error: "Title and artist are required." }, { status: 400 });
  }
  if (!/^[a-z]{2,3}$/i.test(language)) {
    return Response.json({ error: "Choose a language code such as en." }, { status: 400 });
  }
  if (!acceptTerms || !confirmRights) {
    return Response.json({ error: "Accept the terms and confirm you have the rights." }, { status: 400 });
  }

  const uploaded = form.audio;
  const wantsVault = source === "vault" || (source !== "upload" && Boolean(vaultTrackId) && !uploaded);
  const wantsUpload = source === "upload" || (!wantsVault && Boolean(uploaded));
  if (wantsVault && !vaultTrackId) {
    return Response.json({ error: "Choose one of your mastered tracks." }, { status: 400 });
  }
  if (!wantsVault && !wantsUpload) {
    return Response.json({ error: "Select a mastered track or upload a WAV." }, { status: 400 });
  }
  if (wantsUpload && (!uploaded || uploaded.size <= 0)) {
    return Response.json({ error: "Upload a finished WAV." }, { status: 400 });
  }
  if (wantsUpload && uploaded && uploaded.size > MAX_WAV_BYTES) {
    return Response.json({ error: "WAV files must be 200 MB or smaller." }, { status: 400 });
  }

  let supabase: AdminClient;
  try {
    supabase = adminClient();
  } catch {
    return Response.json({ error: "Distribution is not available right now." }, { status: 500 });
  }

  const balance = await readBalance(supabase, userId);
  if (balance === null) {
    return Response.json({ error: "Could not read your D-Token balance." }, { status: 500 });
  }
  if (balance < 1) {
    return Response.json({ error: INSUFFICIENT }, { status: 402 });
  }

  let bytes: Uint8Array;
  let fileName: string;
  if (wantsVault) {
    const loaded = await wavFromVault(supabase, userId, vaultTrackId);
    if (loaded instanceof Response) return loaded;
    bytes = loaded.bytes;
    fileName = loaded.fileName;
  } else {
    const file = uploaded as UploadFile;
    const name = file.name.toLowerCase();
    const type = file.type.toLowerCase();
    const wavType = type === "" || type === "audio/wav" || type === "audio/wave" || type === "audio/x-wav";
    if (!name.endsWith(".wav") || !wavType) {
      return Response.json({ error: "Upload a finished WAV." }, { status: 400 });
    }
    bytes = file.bytes;
    if (!isWav(bytes)) {
      return Response.json({ error: "Upload a finished WAV." }, { status: 400 });
    }
    fileName = safeWavName(file.name);
  }

  let releaseId = 0;
  try {
    const dispatched = await dispatchReleaseToTooLost({
      title,
      artist,
      fileName,
      bytes,
      explicit,
      instrumental,
      language,
    });
    releaseId = dispatched.releaseId;
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return Response.json({ error: "Too Lost is not configured." }, { status: 503 });
    }
    console.error("[distribute] Too Lost dispatch failed");
    return Response.json({ error: VENDOR_FAILURE }, { status: 502 });
  }

  const spendKey = `dist:${randomUUID()}`;
  const { data: rpcData, error: rpcError } = await supabase.rpc("spend_hybrid_tokens", {
    _user_id: userId,
    _amount: 1,
    _note: "Too Lost distribution",
    _idempotency_key: spendKey,
  });
  const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as { ok?: boolean; balance?: number } | null;
  if (rpcError || !row || row.ok !== true) {
    console.error("[distribute] token charge failed after dispatch");
    return Response.json({ error: CHARGE_INCOMPLETE, releaseId }, { status: 500 });
  }

  return Response.json({
    ok: true,
    releaseId,
    balance: typeof row.balance === "number" ? row.balance : balance - 1,
  });
}
