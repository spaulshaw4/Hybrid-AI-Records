import { createFileRoute } from "@tanstack/react-router";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";

/** GET /api/stream/$filename → FastAPI worker on 127.0.0.1:8880 */
export const Route = createFileRoute("/api/stream/$filename")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        proxyToHybridWorker(request, `/api/stream/${encodeURIComponent(params.filename)}`),
    },
  },
});
