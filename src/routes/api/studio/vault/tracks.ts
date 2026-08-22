import { createFileRoute } from "@tanstack/react-router";
import { studioUserIdFromRequestOrDev } from "@/lib/studio-request-auth.server";

/**
 * GET /api/studio/vault/tracks
 * Equivalent of FastAPI `GET /api/studio/vault/tracks` scoped to the Bearer user.
 * Local-dev bypass uses the public test user id and never 500s an empty vault.
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
  const userId = await studioUserIdFromRequestOrDev(request);
  if (!userId) {
    return Response.json({ status: "error", message: "Sign in to load your vault." }, { status: 401 });
  }

  try {
    const { listUserVaultApiTracks } = await import("@/lib/user-vault.server");
    const tracks = await listUserVaultApiTracks(userId);
    return Response.json(tracks);
  } catch (error) {
    console.warn("[vault] list failed", error instanceof Error ? error.message : error);
    return Response.json([]);
  }
}
