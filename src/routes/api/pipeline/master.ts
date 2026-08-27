import { createFileRoute } from "@tanstack/react-router";
import { handleMusicApiPost } from "@/lib/ApiCompressionLine";

/**
 * POST /api/pipeline/master
 *
 * API Compression Line → MasterPipelineRunner dry-run composer.
 * Negotiates gzip/deflate via Accept-Encoding; returns blueprint envelope.
 */
export const Route = createFileRoute("/api/pipeline/master")({
  server: {
    handlers: {
      POST: ({ request }) => handleMusicApiPost(request),
      GET: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "POST" },
  });
}
