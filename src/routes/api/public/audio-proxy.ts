import { createFileRoute } from "@tanstack/react-router";

/**
 * Streams generated audio through our own origin.
 *
 * Some engine/CDN URLs block hotlinking or omit CORS headers, which makes the
 * browser refuse to play them. This proxy is read-only and restricted to the
 * audio hosts we generate from.
 */
const ALLOWED_HOST_SUFFIXES = [
  "replicate.delivery",
  "replicate.com",
  "apiframe.pro",
  "supabase.co",
  "amazonaws.com",
  "cloudfront.net",
];

/** Fallback content types when the upstream sends none or a generic one. */
const EXTENSION_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
};

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "Range, Content-Type, Accept, Origin",
  "access-control-expose-headers":
    "Content-Length, Content-Range, Content-Type, Accept-Ranges, Content-Disposition, X-Upstream-Status, X-Proxy-Reason",
  "access-control-max-age": "86400",
};

function isAllowed(target: URL): boolean {
  if (target.protocol !== "https:") return false;
  return ALLOWED_HOST_SUFFIXES.some(
    (suffix) => target.hostname === suffix || target.hostname.endsWith(`.${suffix}`),
  );
}

function contentTypeFor(target: URL, upstreamType: string | null): string {
  if (upstreamType && upstreamType.startsWith("audio/")) return upstreamType;
  const ext = target.pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] ?? upstreamType ?? "audio/mpeg";
}

/** Magic-byte sniff so mislabeled-but-valid audio still streams. */
function looksLikeAudio(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const ascii = (i: number, text: string) =>
    text.split("").every((ch, n) => bytes[i + n] === ch.charCodeAt(0));
  if (ascii(0, "ID3")) return true; // mp3 with tags
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return true; // wav
  if (ascii(0, "OggS")) return true; // ogg/opus
  if (ascii(0, "fLaC")) return true; // flac
  if (ascii(4, "ftyp")) return true; // m4a/mp4
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true; // raw mp3/aac
  return false;
}

function errorResponse(
  message: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

async function handle(request: Request, method: "GET" | "HEAD"): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const raw = params.get("url");
  const downloadName = params.get("download");
  if (!raw) return errorResponse("Missing url", 400);

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return errorResponse("Invalid url", 400);
  }
  if (!isAllowed(target)) return errorResponse("Host not allowed", 403);

  const range = request.headers.get("range");

  async function fetchUpstream(init: RequestInit): Promise<Response | null> {
    try {
      return await fetch(target.toString(), { redirect: "follow", ...init });
    } catch {
      return null;
    }
  }

  // Transient gateway hiccups (502/503/504/408/429) are retried with
  // exponential backoff so playback recovers without user action.
  const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
  const delays = [250, 700, 1600];

  let upstream = await fetchUpstream({
    method: method === "HEAD" ? "HEAD" : "GET",
    headers: range ? { Range: range } : undefined,
  });

  // Some CDNs reject HEAD or ranged requests. Retry as a plain GET before
  // giving up so playback/downloads still work.
  if (!upstream || (!upstream.ok && upstream.status !== 206)) {
    if (upstream && TRANSIENT.has(upstream.status)) upstream.body?.cancel().catch(() => undefined);
    upstream = await fetchUpstream({ method: "GET" });
  }

  for (const wait of delays) {
    if (upstream && (upstream.ok || upstream.status === 206)) break;
    if (upstream && !TRANSIENT.has(upstream.status)) break;
    if (upstream) upstream.body?.cancel().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, wait));
    upstream = await fetchUpstream({
      method: "GET",
      headers: range ? { Range: range } : undefined,
    });
  }


  // An unreachable host means the temporary engine link is gone — report it as
  // an expired source (410) so the player can offer a regenerate instead of a
  // meaningless 502.
  if (!upstream) {
    return errorResponse("Upstream audio unreachable", 410, {
      "x-upstream-status": "0",
      "x-proxy-reason": "unreachable",
    });
  }
  if (!upstream.ok && upstream.status !== 206) {
    // Mirror the upstream status (403/404/410/…) instead of collapsing to 502
    // so the client can tell "expired link" apart from "server problem".
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    upstream.body?.cancel().catch(() => undefined);
    return errorResponse(`Upstream audio unavailable (${upstream.status})`, status, {
      "x-upstream-status": String(upstream.status),
      "x-proxy-reason": "upstream-error",
    });
  }

  const upstreamType = upstream.headers.get("content-type") ?? "";
  let sniffedBody: ReadableStream<Uint8Array> | null = upstream.body;
  if (/^(text\/|application\/(json|problem\+json))/i.test(upstreamType)) {
    // Some storage hosts mislabel audio objects (e.g. text/plain). Only reject
    // when the bytes themselves are not audio — never block a real file.
    const buffer = new Uint8Array(await upstream.arrayBuffer());
    if (!looksLikeAudio(buffer)) {
      return errorResponse("Upstream returned an invalid audio file", 410, {
        "x-upstream-status": String(upstream.status),
        "x-proxy-reason": "invalid-body",
      });
    }
    sniffedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(buffer);
        controller.close();
      },
    });
  }




  const headers = new Headers(CORS_HEADERS);
  for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set(
    "content-type",
    contentTypeFor(target, upstreamType.startsWith("audio/") ? upstreamType : null),
  );
  // Always advertise range support so browsers can seek and recover on flaky
  // connections instead of aborting playback.
  headers.set("accept-ranges", upstream.headers.get("accept-ranges") ?? "bytes");
  // Rendered masters are immutable once generated.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  headers.set("cross-origin-resource-policy", "cross-origin");
  headers.set("x-content-type-options", "nosniff");
  headers.set("timing-allow-origin", "*");
  if (downloadName) {
    const { attachmentContentDisposition, audioContentTypeForFileName } = await import(
      "@/lib/download-headers"
    );
    const safe = downloadName.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "track";
    headers.set(
      "content-type",
      audioContentTypeForFileName(
        safe,
        contentTypeFor(target, upstreamType.startsWith("audio/") ? upstreamType : null),
      ),
    );
    headers.set("content-disposition", attachmentContentDisposition(safe));
  } else {
    headers.set("content-disposition", "inline");
  }

  return new Response(method === "HEAD" ? null : sniffedBody, {
    status: upstream.status,
    headers,
  });
}

export const Route = createFileRoute("/api/public/audio-proxy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      HEAD: async ({ request }) => handle(request, "HEAD"),
      GET: async ({ request }) => handle(request, "GET"),
    },
  },
});
