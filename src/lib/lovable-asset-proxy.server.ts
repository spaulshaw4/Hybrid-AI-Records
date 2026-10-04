/**
 * Same-origin stand-in for Lovable sidecar assets (`/__l5e/...`).
 *
 * Those paths are not files in this app. Without a proxy the SPA fallback
 * answers with text/html and <audio> reports MEDIA_ERR_SRC_NOT_SUPPORTED.
 * The bytes live on the Lovable app host.
 */

export const LOVABLE_ASSET_ORIGIN = "https://hybrid-ai-studio.lovable.app";

const ASSET_PREFIXES = ["/__l5e/"];

const EXTENSION_TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

type ConnectReq = {
  url?: string;
  method?: string;
  headers: { host?: string | string[]; range?: string | string[] };
};

type ConnectRes = {
  statusCode: number;
  headersSent?: boolean;
  setHeader(name: string, value: string | number | readonly string[]): void;
  write(chunk: Uint8Array): boolean;
  end(chunk?: string): void;
  once(event: "drain", listener: () => void): void;
};

export function isLovableAssetPath(pathname: string): boolean {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (path.includes("..") || path.includes("\\")) return false;
  return ASSET_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function isHtmlContentType(contentType: string): boolean {
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return base === "text/html" || base === "application/xhtml+xml";
}

export function bytesLookLikeHtml(bytes: Uint8Array): boolean {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  while (
    start < bytes.length &&
    (bytes[start] === 9 || bytes[start] === 10 || bytes[start] === 13 || bytes[start] === 32)
  ) {
    start += 1;
  }
  const sample = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(start, Math.min(bytes.length, start + 64)))
    .toLowerCase();
  return (
    sample.startsWith("<!doctype") ||
    sample.startsWith("<html") ||
    sample.startsWith("<head") ||
    sample.startsWith("<body")
  );
}

function mediaContentType(pathname: string, upstreamType: string): string {
  const raw = upstreamType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    raw.startsWith("audio/") ||
    raw.startsWith("image/") ||
    raw.startsWith("video/") ||
    raw.startsWith("font/")
  ) {
    return raw;
  }
  const ext = pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TYPES[ext] || raw || "application/octet-stream";
}

function plainError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

async function bodyWithoutHtml(
  upstream: Response,
): Promise<{ body: ReadableStream<Uint8Array> | null; html: boolean }> {
  if (!upstream.body) return { body: null, html: false };
  const reader = upstream.body.getReader();
  const first = await reader.read();
  const chunk = first.value ?? new Uint8Array();
  if (bytesLookLikeHtml(chunk)) {
    await reader.cancel().catch(() => undefined);
    return { body: null, html: true };
  }
  let pending: Uint8Array | null = chunk.byteLength ? chunk : null;
  let opened = first.done;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        const bytes = pending;
        pending = null;
        controller.enqueue(bytes);
        if (opened) controller.close();
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { body: stream, html: false };
}

/**
 * Proxy a `/__l5e/` request to the Lovable host.
 * Returns null when the path is not a sidecar asset.
 */
export async function proxyLovableAsset(request: Request): Promise<Response | null> {
  const incoming = new URL(request.url);
  if (!isLovableAssetPath(incoming.pathname)) return null;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const target = new URL(`${incoming.pathname}${incoming.search}`, LOVABLE_ASSET_ORIGIN);
  const headers = new Headers();
  headers.set("accept-encoding", "identity");
  const range = request.headers.get("range");
  if (range) headers.set("range", range);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      redirect: "follow",
    });
  } catch {
    return plainError("Catalog asset is not available", 502);
  }

  const upstreamType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok && upstream.status !== 206) {
    await upstream.body?.cancel().catch(() => undefined);
    const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
    return plainError("Catalog asset is not available", status);
  }
  if (isHtmlContentType(upstreamType)) {
    await upstream.body?.cancel().catch(() => undefined);
    return plainError("Catalog asset is not available", upstream.status === 200 ? 502 : upstream.status);
  }

  let guarded: { body: ReadableStream<Uint8Array> | null; html: boolean };
  if (request.method === "HEAD") {
    await upstream.body?.cancel().catch(() => undefined);
    guarded = { body: null, html: false };
  } else {
    guarded = await bodyWithoutHtml(upstream);
  }
  if (guarded.html) {
    return plainError("Catalog asset is not available", 502);
  }

  const responseHeaders = new Headers();
  responseHeaders.set("content-type", mediaContentType(target.pathname, upstreamType));
  responseHeaders.set("accept-ranges", upstream.headers.get("accept-ranges") || "bytes");
  responseHeaders.set("x-content-type-options", "nosniff");
  responseHeaders.set(
    "cache-control",
    upstream.headers.get("cache-control") || "public, max-age=86400",
  );
  for (const key of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(key);
    if (value) responseHeaders.set(key, value);
  }

  return new Response(request.method === "HEAD" ? null : guarded.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

/** Vite dev/preview middleware. Runs before the SPA HTML fallback. */
export function lovableAssetDevMiddleware() {
  return (req: ConnectReq, res: ConnectRes, next: (err?: unknown) => void) => {
    const rawUrl = req.url || "/";
    const pathname = rawUrl.split("?")[0] || "/";
    if (!isLovableAssetPath(pathname)) {
      next();
      return;
    }

    const host = headerValue(req.headers.host) || "127.0.0.1:8080";
    const range = headerValue(req.headers.range);
    const headers = new Headers();
    if (range) headers.set("range", range);
    const request = new Request(`http://${host}${rawUrl}`, {
      method: req.method || "GET",
      headers,
    });

    void proxyLovableAsset(request)
      .then(async (proxied) => {
        if (!proxied) {
          next();
          return;
        }
        res.statusCode = proxied.status;
        proxied.headers.forEach((value, key) => {
          if (key === "transfer-encoding") return;
          res.setHeader(key, value);
        });
        if (!proxied.body || (req.method || "GET").toUpperCase() === "HEAD") {
          res.end();
          return;
        }
        const reader = proxied.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && !res.write(value)) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
        res.end();
      })
      .catch((error: unknown) => {
        if (res.headersSent) res.end();
        else next(error);
      });
  };
}
