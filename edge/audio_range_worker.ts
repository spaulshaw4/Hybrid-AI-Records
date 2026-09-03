/**
 * Cloudflare Worker: authenticated byte-range proxy for /stream/.
 *
 * Secrets stay in wrangler/env (AUTH_SECRET, AUDIO_ORIGIN). This file has none.
 * Unauthenticated /stream/ requests are rejected except OPTIONS.
 */

export type AudioRangeEnv = {
  AUTH_SECRET?: string;
  AUDIO_ORIGIN?: string;
};

const ALLOWED_PREFIXES = ["releases/", "scratch/"];
const ALLOWED_EXT = /\.(wav|flac|m4a|mp3|aac)$/i;
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, Content-Type, x-audio-token",
  "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function corsHeaders(extra?: Record<string, string>): Headers {
  return new Headers({ ...CORS, ...(extra ?? {}) });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    }),
  });
}

export function sanitizeStreamPath(pathname: string): string | null {
  const stripped = pathname
    .replace(/^\/stream\//, "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/");
  if (!stripped || stripped.includes("..") || stripped.includes("\0")) return null;
  if (!ALLOWED_EXT.test(stripped)) return null;
  if (!ALLOWED_PREFIXES.some((prefix) => stripped.startsWith(prefix))) return null;
  return stripped;
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mix = 0;
  for (let i = 0; i < left.length; i += 1) {
    mix |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return mix === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function authorizeStream(
  request: Request,
  secret: string,
  path: string,
): Promise<boolean> {
  if (!secret) return false;
  const url = new URL(request.url);
  const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const headerToken = (request.headers.get("x-audio-token") || "").trim();
  const queryToken = (url.searchParams.get("token") || "").trim();
  if (bearer && timingSafeEqual(bearer, secret)) return true;
  if (headerToken && timingSafeEqual(headerToken, secret)) return true;
  if (queryToken && timingSafeEqual(queryToken, secret)) return true;

  const provided = (url.searchParams.get("sig") || url.searchParams.get("hmac") || "")
    .trim()
    .toLowerCase();
  if (!provided) return false;
  const expected = await hmacHex(secret, path);
  return timingSafeEqual(provided, expected);
}

export default {
  async fetch(request: Request, env: AudioRangeEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/stream/")) {
      return errorResponse(404, "Not found");
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "Method not allowed");
    }

    const path = sanitizeStreamPath(url.pathname);
    if (!path) {
      return errorResponse(400, "Invalid stream path");
    }

    const secret = env.AUTH_SECRET?.trim() || "";
    const allowed = await authorizeStream(request, secret, path);
    if (!allowed) {
      return errorResponse(401, "Authentication required");
    }

    const origin = env.AUDIO_ORIGIN?.trim().replace(/\/$/, "") || "";
    if (!origin) {
      return errorResponse(502, "AUDIO_ORIGIN is not configured");
    }

    const upstreamHeaders = new Headers();
    const range = request.headers.get("Range") || request.headers.get("range");
    if (range) upstreamHeaders.set("Range", range);

    const upstream = await fetch(`${origin}/${path}`, {
      method: request.method,
      headers: upstreamHeaders,
    });

    const outbound = new Headers(upstream.headers);
    for (const [key, value] of Object.entries(CORS)) {
      outbound.set(key, value);
    }
    if (upstream.ok || upstream.status === 206) {
      if (!outbound.has("Cache-Control")) {
        outbound.set("Cache-Control", "public, max-age=86400, immutable");
      }
    } else {
      outbound.set("Cache-Control", "no-store");
    }

    return new Response(request.method === "HEAD" ? null : upstream.body, {
      status: upstream.status,
      headers: outbound,
    });
  },
};
