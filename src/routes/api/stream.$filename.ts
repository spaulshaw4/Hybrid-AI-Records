import { createFileRoute } from "@tanstack/react-router";
import { proxyToHybridWorker } from "@/lib/hybrid-worker-proxy.server";
import { localMasterResponse } from "@/lib/track-create.server";

/** GET /api/stream/$filename — local master if this process wrote it. */
export const Route = createFileRoute("/api/stream/$filename")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const local = await localMasterResponse(params.filename);
        if (local) return local;
        return proxyToHybridWorker(request, `/api/stream/${encodeURIComponent(params.filename)}`);
      },
    },
  },
});
