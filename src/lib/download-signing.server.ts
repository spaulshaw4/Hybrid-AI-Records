/**
 * Short-lived signed download tokens.
 *
 * A token binds one track to one account and expires in minutes, so a copied
 * link stops working almost immediately and can never be shared as a
 * permanent public URL. Signed with HMAC-SHA256 using a server-only secret.
 */

/** Tokens are valid for five minutes — long enough to start a download. */
export const DOWNLOAD_TOKEN_TTL_SECONDS = 300;

type TokenPayload = {
  /** Track id from the catalog. */
  t: string;
  /** Owner account id. */
  u: string;
  /** Suggested file name. */
  f: string;
  /** Expiry, epoch seconds. */
  e: number;
};

function secret(): string {
  const value = process.env["DOWNLOAD_SIGNING_SECRET"];
  if (!value) throw new Error("DOWNLOAD_SIGNING_SECRET is not configured");
  return value;
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function sign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64url(new Uint8Array(signature));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mints a token for one track + owner, valid for a few minutes. */
export async function signDownloadToken(input: {
  trackId: string;
  userId: string;
  fileName: string;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresAt: number }> {
  const expiresAt =
    Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? DOWNLOAD_TOKEN_TTL_SECONDS);
  const payload: TokenPayload = {
    t: input.trackId,
    u: input.userId,
    f: input.fileName,
    e: expiresAt,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(body);
  return { token: `${body}.${signature}`, expiresAt };
}

/** Verifies signature + expiry. Returns null for anything tampered or stale. */
export async function verifyDownloadToken(token: string | null): Promise<TokenPayload | null> {
  if (!token || token.length > 2048) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  let expected: string;
  try {
    expected = await sign(body);
  } catch {
    return null;
  }
  if (!timingSafeEqual(signature, expected)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as TokenPayload;
  } catch {
    return null;
  }
  if (!payload?.t || !payload?.u || typeof payload.e !== "number") return null;
  if (payload.e * 1000 < Date.now()) return null;
  return payload;
}

/** Relative, signed download path for a track. */
export function downloadPathFor(token: string): string {
  return `/api/public/track-download?token=${encodeURIComponent(token)}`;
}
