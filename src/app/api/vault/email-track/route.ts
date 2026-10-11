import type { SupabaseClient } from "@supabase/supabase-js";
import { vaultAdminClient } from "@/lib/vault-admin.server";
import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { sendVaultMasterDownloadEmail } from "@/lib/resend.server";

const DOWNLOAD_TTL_SECONDS = 48 * 60 * 60;

type VaultEmailRow = {
  id?: string | null;
  title?: string | null;
  wav_url?: string | null;
  mp3_url?: string | null;
  user_id?: string | null;
};

function hasBearer(request: Request): boolean {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") && header.slice("Bearer ".length).trim().length > 0;
}

function trackIdFrom(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const value = (body as { trackId?: unknown }).trackId;
  return typeof value === "string" ? value.trim() : "";
}

function emailTitle(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/[\r\n\t]+/g, " ").trim() : "";
  return text.slice(0, 180) || "Untitled";
}

function projectHost(): string {
  const raw = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return "";
  }
}

/** Object path inside the audio-vault bucket, from a public or signed storage URL. */
function audioVaultObjectPath(storedUrl: string): string | null {
  try {
    const parsed = new URL(storedUrl);
    const marker = "/audio-vault/";
    const index = parsed.pathname.indexOf(marker);
    if (index === -1) return null;
    const path = decodeURIComponent(parsed.pathname.slice(index + marker.length)).replace(/^\/+/, "");
    if (!path || path.includes("..")) return null;
    return path;
  } catch {
    return null;
  }
}

function usableAudioUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text === "null" || text === "undefined") return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (audioVaultObjectPath(text)) return text;
  if (/\.(wav|mp3|flac|aiff|m4a|aac|ogg)(?:$|[?#])/i.test(url.pathname)) return text;
  return null;
}

/**
 * Permanent public object only. Rejects token queries and signed storage paths.
 * Never logs the URL.
 */
function permanentPublicMasterUrl(storedUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(storedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = projectHost();
  if (!host || url.host.toLowerCase() !== host) return null;
  if (url.searchParams.has("token")) return null;
  if (/\/object\/sign\//i.test(url.pathname)) return null;
  if (!url.pathname.includes("/storage/v1/object/public/audio-vault/")) return null;
  return storedUrl;
}

async function masterDownloadUrl(admin: SupabaseClient, storedUrl: string): Promise<string | null> {
  const path = audioVaultObjectPath(storedUrl);
  if (path) {
    try {
      const signed = await admin.storage.from("audio-vault").createSignedUrl(path, DOWNLOAD_TTL_SECONDS);
      const url = signed.data?.signedUrl?.trim() ?? "";
      if (!signed.error && url.startsWith("https://")) return url;
    } catch {
      // Signing failed. The permanent public object is the only allowed fallback.
    }
  }
  return permanentPublicMasterUrl(storedUrl);
}

/**
 * POST /api/vault/email-track
 * Body: { trackId }. A body userId is ignored. The bearer session owns the row.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    return await emailVaultTrack(request);
  } catch {
    return Response.json({ error: "Could not send that email." }, { status: 500 });
  }
}

async function emailVaultTrack(request: Request): Promise<Response> {
  if (!hasBearer(request)) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let session: Awaited<ReturnType<typeof resolveStudioSession>>;
  try {
    session = await resolveStudioSession(request);
  } catch {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }
  const userId = session.userId.trim();
  if (!userId) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "A track id is required." }, { status: 400 });
  }
  const trackId = trackIdFrom(payload);
  if (!trackId) {
    return Response.json({ error: "A track id is required." }, { status: 400 });
  }

  let admin: SupabaseClient;
  try {
    admin = vaultAdminClient();
  } catch {
    return Response.json({ error: "Vault storage is not configured." }, { status: 500 });
  }

  const { data, error } = await admin
    .from("vaulted_tracks")
    .select("id, title, wav_url, mp3_url, user_id")
    .eq("id", trackId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    return Response.json({ error: "Could not load that track." }, { status: 500 });
  }
  const row = data as VaultEmailRow | null;
  if (!row || row.user_id !== userId) {
    return Response.json({ error: "That track is not in your vault." }, { status: 404 });
  }

  const storedUrl = usableAudioUrl(row.wav_url) ?? usableAudioUrl(row.mp3_url);
  if (!storedUrl) {
    return Response.json({ error: "This track has no master audio yet." }, { status: 409 });
  }

  const accountEmail = session.email?.trim() ?? "";
  if (!accountEmail.includes("@")) {
    return Response.json({ error: "No email is on this account." }, { status: 400 });
  }

  const downloadUrl = await masterDownloadUrl(admin, storedUrl);
  if (!downloadUrl) {
    return Response.json({ error: "Could not prepare a download link." }, { status: 502 });
  }

  const sent = await sendVaultMasterDownloadEmail({
    to: accountEmail,
    trackId: (typeof row.id === "string" && row.id.trim()) || trackId,
    trackTitle: emailTitle(row.title),
    downloadUrl,
  });
  if (!sent.ok) {
    if (sent.reason === "not_configured") {
      return Response.json({ error: "Email is not configured." }, { status: 503 });
    }
    return Response.json({ error: "Could not send that email." }, { status: 502 });
  }

  return Response.json({ ok: true });
}
