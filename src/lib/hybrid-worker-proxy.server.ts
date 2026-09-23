/**
 * Same-origin bridge: Vite / TanStack routes forward to FastAPI :8880.
 * Browser Network will show http://127.0.0.1:8080/generate (or /api/tracks/create);
 * this hop posts through to the Python worker so the UI origin is never a dead end.
 */
import {
  DEFAULT_HYBRID_WORKER_URL,
  hybridWorkerUrl,
} from "@/lib/hybrid-worker.server";

export function workerUpstreamBase(): string {
  return hybridWorkerUrl() || DEFAULT_HYBRID_WORKER_URL;
}

export async function proxyToHybridWorker(
  request: Request,
  pathname: string,
): Promise<Response> {
  const base = workerUpstreamBase();
  const incoming = new URL(request.url);
  const target = `${base}${pathname}${incoming.search}`;
  const init: RequestInit = {
    method: request.method,
    headers: {
      "content-type": request.headers.get("content-type") || "application/json",
    },
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[HYBRID_WORKER_PROXY] unreachable", target, detail);
    return Response.json(
      { error: `Local worker unreachable at ${base}`, detail },
      { status: 502 },
    );
  }

  const headers = new Headers(upstream.headers);
  headers.delete("transfer-encoding");
  headers.set("x-hybrid-worker-upstream", `${base}${pathname}`);
  return new Response(upstream.body, { status: upstream.status, headers });
}
