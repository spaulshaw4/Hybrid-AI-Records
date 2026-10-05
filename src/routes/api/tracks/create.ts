import { createFileRoute } from "@tanstack/react-router";
import { handleTrackCreate } from "@/lib/track-create.server";

/**
 * POST /api/tracks/create on the port-3000 Bun server.
 * Returns pending JSON before any Replicate call. Does not proxy to :8880.
 */
export const Route = createFileRoute("/api/tracks/create")({
  server: {
    handlers: {
      POST: ({ request }) => handleTrackCreate(request),
      OPTIONS: () => new Response(null, { status: 204 }),
    },
  },
});
