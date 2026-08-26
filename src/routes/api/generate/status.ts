import { createFileRoute } from "@tanstack/react-router";
import { pollEngineTrackTask } from "@/lib/apiframe-music.functions";
import { studioUserIdFromRequestOrDev } from "@/lib/studio-request-auth.server";

/**
 * GET /api/generate/status?taskId=…
 *
 * Internal poll proxy — MusicAPI / Apiframe keys stay on the server.
 * Browser clients must use this (or the matching server fn), never provider URLs.
 */
export const Route = createFileRoute("/api/generate/status")({
  server: {
    handlers: {
      GET: handleStatus,
      POST: () => methodNotAllowed(),
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "GET" },
  });
}

async function handleStatus({ request }: { request: Request }): Promise<Response> {
  let userId: string | null;
  try {
    userId = await studioUserIdFromRequestOrDev(request);
  } catch {
    return Response.json({ error: "Sign in to check generation status." }, { status: 401 });
  }
  if (!userId) {
    return Response.json({ error: "Sign in to check generation status." }, { status: 401 });
  }

  const taskId = new URL(request.url).searchParams.get("taskId")?.trim() ?? "";
  if (!taskId || taskId.length > 200) {
    return Response.json({ error: "Missing or invalid taskId." }, { status: 400 });
  }

  try {
    const upstreamData = await pollEngineTrackTask(taskId, userId);
    console.log("[Poll Status Proxy]:", JSON.stringify(upstreamData));
    return Response.json(upstreamData);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Could not load generation status.";
    return Response.json({ error: message }, { status: 502 });
  }
}
