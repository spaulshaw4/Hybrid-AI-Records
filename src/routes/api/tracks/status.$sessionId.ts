import { createFileRoute } from "@tanstack/react-router";
import { trackStatusResponse } from "@/lib/track-create.server";

/** GET /api/tracks/status/$sessionId — in-process job, no upstream wait. */
export const Route = createFileRoute("/api/tracks/status/$sessionId")({
  server: {
    handlers: {
      GET: ({ params }) => trackStatusResponse(params.sessionId),
    },
  },
});
