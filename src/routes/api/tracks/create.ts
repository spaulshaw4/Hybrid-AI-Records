import { createFileRoute } from "@tanstack/react-router";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";

/** POST /api/tracks/create → FastAPI worker on 127.0.0.1:8880 */
export const Route = createFileRoute("/api/tracks/create")({
  server: {
    handlers: {
      POST: ({ request }) => proxyToHybridWorker(request, "/api/tracks/create"),
      OPTIONS: ({ request }) => proxyToHybridWorker(request, "/api/tracks/create"),
    },
  },
});
