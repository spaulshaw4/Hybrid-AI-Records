import { createFileRoute } from "@tanstack/react-router";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";

/** POST /generate → FastAPI worker on 127.0.0.1:8880 */
export const Route = createFileRoute("/generate")({
  server: {
    handlers: {
      POST: ({ request }) => proxyToHybridWorker(request, "/generate"),
      OPTIONS: ({ request }) => proxyToHybridWorker(request, "/generate"),
    },
  },
});
