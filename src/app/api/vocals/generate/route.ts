import { randomUUID } from "node:crypto";

import { refundGenerationToken } from "@/lib/generation-tokens.server";
import { resolveStudioSession, UnauthorizedSessionError } from "@/lib/studio-request-auth.server";
import { vaultAdminClient } from "@/lib/vault-admin.server";
import { rememberVocalJob } from "@/lib/vocal-jobs.server";

const CREATE_URL = "https://api.aimusicapi.ai/api/v1/sonic/create";
const PRODUCTION_ORIGIN = "https://hybrid-ai-records.com";
const INSUFFICIENT_TOKENS_ERROR = "Insufficient hybrid tokens";
const TOKEN_DEDUCTION_ERROR = "Failed to process token deduction";
const LYRICS_REQUIRED_ERROR = "Lyrics are required.";
const REFERENCE_ERROR = "Invalid vocal reference.";
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/;

type TokenDebit =
  | { ok: true; spendKey: string }
  | { ok: false; status: 402 | 500; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

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

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host === "[::1]"
  );
}

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function audioVaultHost(): string {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim() || "";
  if (!raw) return "";
  try {
    return bareHost(new URL(raw).hostname);
  } catch {
    return "";
  }
}

/** Link-local, loopback, and localhost hosts are never forwarded. */
function isBlockedReferenceHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map((part) => Number(part));
    if (parts.some((part) => !Number.isInteger(part) || part > 255)) return true;
    if (parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }

  const v6 = host.split("%")[0] ?? host;
  if (v6 === "::1" || /^fe[89ab]/i.test(v6)) return true;
  return false;
}

/**
 * Forwards an https audio-vault URL. Empty values are omitted.
 * http and link-local values are rejected and never fetched.
 * When the project host is unknown, any other https URL may be forwarded.
 */
function gateReference(raw: string): { url: string } | null {
  if (!raw) return { url: "" };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isBlockedReferenceHost(parsed.hostname)) {
    return null;
  }
  const vaultHost = audioVaultHost();
  if (!vaultHost) return { url: raw };
  if (bareHost(parsed.hostname) !== vaultHost) return { url: "" };
  if (!parsed.pathname.includes("/audio-vault/")) return { url: "" };
  return { url: raw };
}

/** Production callback. A localhost app URL must never be sent upstream. */
function vocalWebhookUrl(): string {
  const fallback = `${PRODUCTION_ORIGIN}/api/webhooks/aimusic`;
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || isLocalHost(parsed.hostname)) return fallback;
    return `${parsed.origin}/api/webhooks/aimusic`;
  } catch {
    return fallback;
  }
}

function taskIdFromUpstream(body: unknown): string {
  if (!isRecord(body)) return "";
  const direct = readString(body.task_id);
  if (direct) return direct;
  if (isRecord(body.data)) return readString(body.data.task_id);
  return "";
}

/**
 * Reads token_balances.balance, then burns 1 via spend_hybrid_tokens.
 * The RPC updates the row only while balance >= 1.
 */
async function debitOneHybridToken(userId: string): Promise<TokenDebit> {
  try {
    const supabase = vaultAdminClient();
    const { data, error } = await supabase
      .from("token_balances")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    const balance = typeof data?.balance === "number" ? data.balance : null;
    if (error || balance === null || balance < 1) {
      return { ok: false, status: 402, error: INSUFFICIENT_TOKENS_ERROR };
    }

    const spendKey = `vocal:${randomUUID()}`;
    const { data: rpcData, error: rpcError } = await supabase.rpc("spend_hybrid_tokens", {
      _user_id: userId,
      _amount: 1,
      _note: "Vocals and toplines",
      _idempotency_key: spendKey,
    });
    if (rpcError) {
      console.error("[vocals] token deduction failed");
      return { ok: false, status: 500, error: TOKEN_DEDUCTION_ERROR };
    }
    const row = (Array.isArray(rpcData) ? rpcData[0] : rpcData) as { ok?: boolean } | null;
    if (!row || row.ok !== true) {
      return { ok: false, status: 402, error: INSUFFICIENT_TOKENS_ERROR };
    }
    return { ok: true, spendKey };
  } catch {
    console.error("[vocals] token deduction failed");
    return { ok: false, status: 500, error: TOKEN_DEDUCTION_ERROR };
  }
}

async function refundChargedToken(userId: string, spendKey: string): Promise<void> {
  try {
    const refund = await refundGenerationToken({
      userId,
      amount: 1,
      spendIdempotencyKey: spendKey,
      note: "Refund for failed vocal generation",
    });
    if (!refund.ok) {
      console.error("[vocals] token refund failed");
    }
  } catch {
    console.error("[vocals] token refund failed");
  }
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
    if (isUnauthorized(err)) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    console.error("[vocals] session failed");
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }
  if (!userId || userId === "guest_user") {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: LYRICS_REQUIRED_ERROR }, { status: 400 });
  }

  const record = isRecord(body) ? body : {};
  const lyrics = readString(record.lyrics);
  if (!lyrics) {
    return Response.json({ error: LYRICS_REQUIRED_ERROR }, { status: 400 });
  }

  const title = readString(record.title) || "Untitled Vocal";
  const vocalGender = readString(record.vocalGender);
  const styleTags = readString(record.styleTags);
  const tags = [vocalGender, styleTags].filter(Boolean).join(", ");
  const reference = gateReference(readString(record.vocalAudioUrl) || readString(record.referenceUrl));
  if (!reference) {
    return Response.json({ error: REFERENCE_ERROR }, { status: 400 });
  }

  const debit = await debitOneHybridToken(userId);
  if (!debit.ok) {
    return Response.json({ error: debit.error }, { status: debit.status });
  }

  const apiKey = process.env.AIMUSIC_API_KEY?.trim() ?? "";
  if (!apiKey) {
    await refundChargedToken(userId, debit.spendKey);
    return Response.json({ error: "Missing API key" }, { status: 500 });
  }

  let response: Response;
  try {
    response = await fetch(CREATE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        custom_mode: true,
        mv: "sonic-v4-5",
        title,
        tags,
        prompt: lyrics,
        webhook_url: vocalWebhookUrl(),
        ...(reference.url ? { reference_audio_url: reference.url } : {}),
      }),
    });
  } catch {
    console.error("[vocals] dispatch failed");
    await refundChargedToken(userId, debit.spendKey);
    return Response.json({ error: "Failed to dispatch generation" }, { status: 500 });
  }

  let taskId = "";
  if (response.ok) {
    try {
      taskId = taskIdFromUpstream(await response.json());
    } catch {
      taskId = "";
    }
  }
  if (!response.ok || !taskId || !TASK_ID.test(taskId)) {
    console.error("[vocals] dispatch failed", response.status);
    await refundChargedToken(userId, debit.spendKey);
    return Response.json({ error: "Failed to dispatch generation" }, { status: 500 });
  }

  // vaulted_tracks.wav_url and mp3_url are NOT NULL, and Audio Vault lists those
  // columns with no status filter. A processing insert would fail or show a broken row.
  rememberVocalJob({ taskId, userId, title, lyrics, tags });
  return Response.json({ success: true, taskId });
}
