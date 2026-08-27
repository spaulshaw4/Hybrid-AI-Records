import { createFileRoute } from "@tanstack/react-router";
import { getGenerationQueueJobForUser } from "@/lib/generation-queue.server";
import {
  resolveStudioSession,
  unauthorizedSessionResponse,
} from "@/lib/studio-request-auth.server";

/**
 * GET /api/studio/generate-queue/$jobId
 * Status for the caller's own queued job only (user_id scoped).
 */
export const Route = createFileRoute("/api/studio/generate-queue/$jobId")({
  server: {
    handlers: {
      GET: handleGet,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function handleGet({
  request,
  params,
}: {
  request: Request;
  params: { jobId: string };
}): Promise<Response> {
  let session;
  try {
    session = await resolveStudioSession(request);
  } catch {
    return unauthorizedSessionResponse();
  }

  const jobId = params.jobId?.trim() ?? "";
  if (!UUID.test(jobId)) {
    return Response.json({ error: "Invalid job id." }, { status: 400 });
  }

  const job = await getGenerationQueueJobForUser(session.userId, jobId);
  if (!job) {
    return Response.json({ error: "Job not found." }, { status: 404 });
  }

  return Response.json({
    queueId: job.id,
    vaultId: job.vault_id,
    status: job.status,
    error: job.error_message,
    result: job.result,
    createdAt: job.created_at,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  });
}
