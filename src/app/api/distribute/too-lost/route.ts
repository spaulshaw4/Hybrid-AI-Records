import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  classifyCover,
  classifyUploadAudio,
  COVER_MAX_BYTES,
  COVER_TOO_LARGE,
  DEFAULT_RECORD_LABEL,
  isDistributionGenre,
  isRecordingType,
  isWav,
} from "@/lib/distribution-media";
import { dispatchReleaseToTooLost, type ReleaseClip } from "@/lib/too-lost/dispatch";
import { AuthRequiredError } from "@/lib/too-lost/errors";
import { resolveStudioSession, UnauthorizedSessionError } from "@/lib/studio-request-auth.server";

const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const INSUFFICIENT = "You need 1 D-Token to distribute a release.";
const BALANCE_UNAVAILABLE = "D-Token balance is not available.";
const VENDOR_FAILURE = "Too Lost could not accept this release. Nothing was charged.";
const CHARGE_INCOMPLETE =
  "Too Lost accepted the release, but the D-Token could not be charged. Contact support before submitting again.";

type AdminClient = SupabaseClient;
type PgError = { code?: string; message?: string } | null;

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

function adminClient(): AdminClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Supabase is not configured");
  return createClient(url, key);
}

function errorText(error: PgError): string {
  return (error?.message ?? "").toLowerCase();
}

function columnMissing(error: PgError, column: string): boolean {
  if (!error) return false;
  const text = errorText(error);
  const named = text.includes(column.toLowerCase());
  return named && (text.includes("column") || text.includes("schema") || error.code === "42703" || error.code === "PGRST204");
}

/**
 * D-Token balance lives on profiles.d_tokens.
 * This schema keys profiles by user_id. Production rows keyed by id are tried only when user_id is absent.
 */
async function readDTokens(supabase: AdminClient, userId: string): Promise<number | "unavailable" | "unreadable"> {
  let sawKey = false;
  for (const key of ["user_id", "id"] as const) {
    const { data, error } = await supabase.from("profiles").select("d_tokens").eq(key, userId).maybeSingle();
    if (columnMissing(error, "d_tokens")) return "unavailable";
    if (columnMissing(error, key)) continue;
    if (error) return "unreadable";
    sawKey = true;
    if (!data) continue;
    const balance = (data as { d_tokens?: unknown }).d_tokens;
    if (typeof balance === "number" && Number.isFinite(balance)) return balance;
    if (typeof data === "object" && data && !("d_tokens" in data)) return "unavailable";
    return "unreadable";
  }
  return sawKey ? 0 : "unavailable";
}

async function debitDToken(supabase: AdminClient, userId: string, balance: number): Promise<number | null> {
  const next = balance - 1;
  for (const key of ["user_id", "id"] as const) {
    const { data, error } = await supabase
      .from("profiles")
      .update({ d_tokens: next })
      .eq(key, userId)
      .gte("d_tokens", 1)
      .select("d_tokens");
    if (columnMissing(error, key)) continue;
    if (error) return null;
    const rows = Array.isArray(data) ? data : [];
    const row = rows[0] as { d_tokens?: unknown } | undefined;
    if (row && typeof row.d_tokens === "number") return row.d_tokens;
    return null;
  }
  return null;
}

function safeAudioName(name: string, kind: "wav" | "flac"): string {
  const ext = kind === "flac" ? ".flac" : ".wav";
  const base = (name.split(/[/\\]/).pop() ?? `track${ext}`).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const stem = base.replace(/\.(wav|flac|mp3)$/i, "") || "track";
  return `${stem}${ext}`.slice(0, 84);
}

function safeCoverName(name: string, kind: "jpeg" | "png"): string {
  const ext = kind === "png" ? ".png" : ".jpg";
  const base = (name.split(/[/\\]/).pop() ?? "cover").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const stem = base.replace(/\.(png|jpe?g|webp|gif)$/i, "") || "cover";
  return `${stem}${ext}`.slice(0, 84);
}

type UploadFile = {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
};

type ReleaseForm = {
  fields: Map<string, string>;
  audios: UploadFile[];
  cover: UploadFile | null;
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
  const audios: UploadFile[] = [];
  let cover: UploadFile | null = null;
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
        const file = { name: filename || "upload", type, size: bytes.byteLength, bytes };
        if (name === "cover") cover = file;
        else if (name === "audio") audios.push(file);
      } else if (name) {
        fields.set(name, new TextDecoder().decode(data).replace(/\r\n$/, ""));
      }
    }
    cursor = next;
  }
  return { fields, audios, cover };
}

function artistIdOrNull(raw: string): string | number | null {
  if (!raw) return null;
  if (/^[1-9]\d{0,17}$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return raw.slice(0, 120);
}

/** profiles.display_name. This schema has no full_name column. */
async function readDisplayName(supabase: AdminClient, userId: string): Promise<string> {
  for (const key of ["user_id", "id"] as const) {
    const { data, error } = await supabase.from("profiles").select("display_name").eq(key, userId).maybeSingle();
    if (columnMissing(error, key) || columnMissing(error, "display_name")) continue;
    if (error || !data) continue;
    const name = (data as { display_name?: unknown }).display_name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 200);
  }
  return "";
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
  if (bytes.byteLength > MAX_AUDIO_BYTES || !isWav(bytes)) {
    return Response.json({ error: "That mastered track is not a WAV we can send." }, { status: 400 });
  }
  const title = typeof data.title === "string" && data.title.trim() ? data.title.trim() : "track";
  return { bytes, fileName: safeAudioName(`${title}.wav`, "wav") };
}

/**
 * POST /api/distribute/too-lost
 * Session user id is the only trusted user id. Body userId is ignored.
 * One profiles.d_tokens unit is decremented only after Too Lost returns HTTP 200 or 201 with a release id.
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
  const trackType = field(form.fields, "trackType") || field(form.fields, "track_type");
  const instrumental = field(form.fields, "instrumental") === "true" || trackType.toLowerCase() === "instrumental";
  const explicit = field(form.fields, "explicit") === "true";
  const language = field(form.fields, "language") || "en";
  const genre = field(form.fields, "genre");
  const label = (field(form.fields, "label") || DEFAULT_RECORD_LABEL).slice(0, 120);
  const composer = field(form.fields, "composer").slice(0, 200);
  const lyricist = field(form.fields, "lyricist").slice(0, 200);
  const pLine = field(form.fields, "pLine").slice(0, 200);
  const cLine = field(form.fields, "cLine").slice(0, 200);
  const recordingType = field(form.fields, "recordingType");
  const sampleClearance = field(form.fields, "sampleClearance") === "true";

  if (!title || !artist) {
    return Response.json({ error: "Title and artist are required." }, { status: 400 });
  }
  if (!/^[a-z]{2,3}$/i.test(language)) {
    return Response.json({ error: "Choose a language code such as en." }, { status: 400 });
  }
  if (!acceptTerms || !confirmRights) {
    return Response.json({ error: "Accept the terms and confirm you have the rights." }, { status: 400 });
  }
  if (!isDistributionGenre(genre)) {
    return Response.json({ error: "Choose a genre." }, { status: 400 });
  }
  if (!composer || !lyricist || !pLine || !cLine) {
    return Response.json({ error: "Composer, lyricist, P-line, and C-line are required." }, { status: 400 });
  }
  if (!isRecordingType(recordingType)) {
    return Response.json({ error: "Choose a track creation method." }, { status: 400 });
  }
  if (!sampleClearance) {
    return Response.json(
      { error: "Certify that the track has no uncleared samples or voice clones." },
      { status: 400 },
    );
  }

  const uploaded = form.audios;
  const wantsVault = source === "vault" || (source !== "upload" && Boolean(vaultTrackId) && uploaded.length === 0);
  const wantsUpload = source === "upload" || (!wantsVault && uploaded.length > 0);
  if (wantsVault && !vaultTrackId) {
    return Response.json({ error: "Choose one of your mastered tracks." }, { status: 400 });
  }
  if (!wantsVault && !wantsUpload) {
    return Response.json({ error: "Select a mastered track or upload a WAV or FLAC file." }, { status: 400 });
  }
  if (wantsUpload && (uploaded.length === 0 || uploaded.some((file) => file.size <= 0))) {
    return Response.json({ error: "Upload a 16-bit or 24-bit WAV, or a FLAC file." }, { status: 400 });
  }
  if (wantsUpload && uploaded.some((file) => file.size > MAX_AUDIO_BYTES)) {
    return Response.json({ error: "Audio files must be 200 MB or smaller." }, { status: 400 });
  }
  if (!form.cover || form.cover.size <= 0) {
    return Response.json({ error: "Cover art is required." }, { status: 400 });
  }
  if (form.cover.size >= COVER_MAX_BYTES) {
    return Response.json({ error: COVER_TOO_LARGE }, { status: 400 });
  }
  const coverKind = classifyCover(form.cover.bytes);
  if (!coverKind.ok) {
    return Response.json({ error: coverKind.error }, { status: 400 });
  }

  const uploadClips: ReleaseClip[] = [];
  if (wantsUpload) {
    for (const file of uploaded) {
      const classified = classifyUploadAudio(file.name, file.type, file.bytes);
      if (!classified.ok) {
        return Response.json({ error: classified.error }, { status: 400 });
      }
      uploadClips.push({
        fileName: safeAudioName(file.name, classified.kind),
        bytes: file.bytes,
        audioContentType: classified.kind === "flac" ? "audio/flac" : "audio/wav",
      });
    }
  }

  let supabase: AdminClient;
  try {
    supabase = adminClient();
  } catch {
    return Response.json({ error: "Distribution is not available right now." }, { status: 500 });
  }

  const balance = await readDTokens(supabase, userId);
  if (balance === "unavailable") {
    return Response.json({ error: BALANCE_UNAVAILABLE }, { status: 503 });
  }
  if (balance === "unreadable") {
    return Response.json({ error: "Could not read your D-Token balance." }, { status: 500 });
  }
  if (balance < 1) {
    return Response.json({ error: INSUFFICIENT }, { status: 402 });
  }

  const clips: ReleaseClip[] = [];
  if (wantsVault) {
    const loaded = await wavFromVault(supabase, userId, vaultTrackId);
    if (loaded instanceof Response) return loaded;
    clips.push({ fileName: loaded.fileName, bytes: loaded.bytes, audioContentType: "audio/wav" });
  } else {
    clips.push(...uploadClips);
  }
  const first = clips[0];
  if (!first) {
    return Response.json({ error: "Select a mastered track or upload a WAV or FLAC file." }, { status: 400 });
  }
  const displayName = await readDisplayName(supabase, userId);
  const artistId = artistIdOrNull(field(form.fields, "primary_artist_id") || field(form.fields, "artistId"));
  const releaseDate = field(form.fields, "release_date") || field(form.fields, "releaseDate");
  const lyrics = field(form.fields, "lyrics").slice(0, 8000);

  let dispatched: Awaited<ReturnType<typeof dispatchReleaseToTooLost>>;
  try {
    dispatched = await dispatchReleaseToTooLost({
      title,
      artist,
      fileName: first.fileName,
      bytes: first.bytes,
      audioContentType: first.audioContentType,
      clips,
      explicit,
      instrumental,
      language,
      label,
      genre,
      composer,
      lyricist,
      pLine,
      cLine,
      recordingType,
      lyrics,
      artistId,
      releaseDate,
      displayName,
      cover: {
        fileName: safeCoverName(form.cover.name, coverKind.kind),
        bytes: form.cover.bytes,
        contentType: coverKind.contentType,
      },
    });
  } catch (err) {
    if (err instanceof AuthRequiredError) {
      return Response.json({ error: "Too Lost is not configured." }, { status: 503 });
    }
    console.error("[distribute] Too Lost dispatch failed");
    return Response.json({ error: VENDOR_FAILURE }, { status: 502 });
  }

  if (!dispatched.accepted) {
    return Response.json({ error: VENDOR_FAILURE }, { status: 502 });
  }

  const nextBalance = await debitDToken(supabase, userId, balance);
  if (nextBalance === null) {
    console.error("[distribute] token charge failed after dispatch");
    return Response.json(
      {
        error: CHARGE_INCOMPLETE,
        releaseId: dispatched.releaseId,
        status: dispatched.status,
        spotifyUri: dispatched.spotifyUri,
        upc: dispatched.upc,
      },
      { status: 500 },
    );
  }

  return Response.json({
    ok: true,
    releaseId: dispatched.releaseId,
    status: dispatched.status,
    spotifyUri: dispatched.spotifyUri,
    upc: dispatched.upc,
    balance: nextBalance,
  });
}
