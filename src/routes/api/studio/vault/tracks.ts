import { createFileRoute } from "@tanstack/react-router";
import {
  resolveStudioSession,
  unauthorizedSessionResponse,
} from "@/lib/studio-request-auth.server";

/**
 * GET /api/studio/vault/tracks
 * Catalog scoped to the verified session user only (RLS / explicit user_id).
 */
export const Route = createFileRoute("/api/studio/vault/tracks")({
  server: {
    handlers: {
      GET: handleList,
      POST: () => methodNotAllowed("GET"),
      PUT: () => methodNotAllowed("GET"),
      DELETE: () => methodNotAllowed("GET"),
    },
  },
});

function methodNotAllowed(allow: string): Response {
  return Response.json({ status: "error", message: "Method not allowed" }, {
    status: 405,
    headers: { allow },
  });
}

async function handleList({ request }: { request: Request }): Promise<Response> {
  let session;
  try {
    session = await resolveStudioSession(request);
  } catch {
    return unauthorizedSessionResponse();
  }

  try {
    const { listUserVaultApiTracks } = await import("@/lib/user-vault.server");
    const tracks = await listUserVaultApiTracks(session.userId);
    return Response.json(tracks);
  } catch (error) {
    console.warn("[vault] list failed", error instanceof Error ? error.message : error);
    return Response.json([]);
  }
}
