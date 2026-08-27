import { createFileRoute } from "@tanstack/react-router";
import {
  resolveStudioSession,
  unauthorizedSessionResponse,
} from "@/lib/studio-request-auth.server";

/**
 * GET  /api/studio/vault/tracks/:trackId — one row for status polling.
 * DELETE /api/studio/vault/tracks/:trackId — database row + storage objects
 * (master, vocal, and instrumental). Always scoped to session user.id.
 */
export const Route = createFileRoute("/api/studio/vault/tracks/$trackId")({
  server: {
    handlers: {
      DELETE: handleDelete,
      GET: handleGetOne,
      POST: () => methodNotAllowed("DELETE, GET"),
      PUT: () => methodNotAllowed("DELETE, GET"),
    },
  },
});

function methodNotAllowed(allow: string): Response {
  return Response.json({ status: "error", message: "Method not allowed" }, {
    status: 405,
    headers: { allow },
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handleGetOne({
  request,
  params,
}: {
  request: Request;
  params: { trackId: string };
}): Promise<Response> {
  let session;
  try {
    session = await resolveStudioSession(request);
  } catch {
    return unauthorizedSessionResponse();
  }

  const trackId = params.trackId?.trim() ?? "";
  if (!UUID.test(trackId)) {
    return Response.json({ status: "error", message: "That vault track id is invalid." }, { status: 400 });
  }

  try {
    const { getUserVaultApiTrack } = await import("@/lib/user-vault.server");
    const track = await getUserVaultApiTrack(session.userId, trackId);
    if (!track) {
      return Response.json({ status: "error", message: "Track not found." }, { status: 404 });
    }
    return Response.json(track);
  } catch (error) {
    console.warn("[vault] get failed", error instanceof Error ? error.message : error);
    return Response.json({ status: "error", message: "Track not found." }, { status: 404 });
  }
}

async function handleDelete({
  request,
  params,
}: {
  request: Request;
  params: { trackId: string };
}): Promise<Response> {
  let session;
  try {
    session = await resolveStudioSession(request);
  } catch {
    return unauthorizedSessionResponse();
  }

  const trackId = params.trackId?.trim() ?? "";
  if (!UUID.test(trackId)) {
    return Response.json({ status: "error", message: "That vault track id is invalid." }, { status: 400 });
  }

  try {
    const { deleteUserVaultApiTrack } = await import("@/lib/user-vault.server");
    const deleted = await deleteUserVaultApiTrack(session.userId, trackId);
    if (!deleted) {
      return Response.json({ status: "error", message: "Track not found." }, { status: 404 });
    }
    return Response.json({ status: "success", message: "Track deleted successfully" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deletion failed on server";
    return Response.json({ status: "error", message }, { status: 500 });
  }
}
