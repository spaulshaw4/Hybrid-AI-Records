import { createFileRoute } from "@tanstack/react-router";

/**
 * Serves a catalog track only for a valid, unexpired signed token.
 *
 * The token is minted server-side after we confirm the account owns the track,
 * so a copied link dies within minutes and never exposes a permanent public
 * file URL. Nothing here trusts a client-supplied file path.
 */
function deny(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handle(request: Request, method: "GET" | "HEAD"): Promise<Response> {
  const requestUrl = new URL(request.url);
  const { verifyDownloadToken } = await import("@/lib/download-signing.server");
  const payload = await verifyDownloadToken(requestUrl.searchParams.get("token"));
  if (!payload) return deny("This download link has expired. Open it again from your library.", 403);

  const { STREAM_TRACKS } = await import("@/lib/radio-tracks");
  const track = STREAM_TRACKS.find((item) => item.id === payload.t);
  if (!track) return deny("Track not found", 404);

  const source = track.src.startsWith("http")
    ? track.src
    : new URL(track.src, requestUrl.origin).toString();

  let upstream: Response;
  try {
    upstream = await fetch(source, {
      redirect: "follow",
      headers: request.headers.get("range") ? { Range: request.headers.get("range")! } : undefined,
    });
  } catch {
    return deny("Track file is temporarily unavailable", 502);
  }
  if (!upstream.ok && upstream.status !== 206) {
    upstream.body?.cancel().catch(() => undefined);
    return deny("Track file is temporarily unavailable", 502);
  }

  const safeName = (payload.f || `${track.title}.mp3`).replace(/[^\w.\- ]+/g, "_").slice(0, 120);
  const headers = new Headers();
  for (const key of ["content-length", "content-range", "accept-ranges"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  headers.set("content-type", upstream.headers.get("content-type") ?? "audio/mpeg");
  headers.set("content-disposition", `attachment; filename="${safeName}"`);
  // Signed, per-user link: never cacheable by shared caches.
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers,
  });
}

export const Route = createFileRoute("/api/public/track-download")({
  server: {
    handlers: {
      HEAD: async ({ request }) => handle(request, "HEAD"),
      GET: async ({ request }) => handle(request, "GET"),
    },
  },
});
