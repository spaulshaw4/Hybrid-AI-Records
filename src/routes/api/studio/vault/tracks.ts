import { createFileRoute } from "@tanstack/react-router";
import { studioUserIdFromRequest } from "@/lib/studio-request-auth.server";

/**
 * GET /api/studio/vault/tracks
 * Equivalent of FastAPI `GET /api/studio/vault/tracks` scoped to the Bearer user.
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
  let userId: string;
  try {
    userId = await studioUserIdFromRequest(request);
  } catch {
    return Response.json({ status: "error", message: "Sign in to load your vault." }, { status: 401 });
  }

  try {
    const { listUserVaultApiTracks } = await import("@/lib/user-vault.server");
    const tracks = await listUserVaultApiTracks(userId);
    return Response.json(tracks);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load vault items";
    return Response.json({ status: "error", message }, { status: 500 });
  }
}
