import { createFileRoute } from "@tanstack/react-router";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";

/** GET /api/tracks/status/$sessionId → FastAPI worker on 127.0.0.1:8880 */
export const Route = createFileRoute("/api/tracks/status/$sessionId")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        proxyToHybridWorker(
          request,
          `/api/tracks/status/${encodeURIComponent(params.sessionId)}`,
        ),
    },
  },
});
