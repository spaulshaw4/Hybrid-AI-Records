import { createFileRoute } from "@tanstack/react-router";
import {
  cortexErrorResponse,
  executeGenerationCortex,
} from "@/lib/cortex-dispatcher.server";

/**
 * POST /api/studio/generate-stream
 *
 * Cloud-native ingress (same contract as /generate-queue):
 * auth → atomic token spend → insert pending job → **202 immediately**.
 * Heavy shared-key work runs only in the isolated generation-jobs worker —
 * this route never holds an open processing loop (no request timeouts).
 */
export const Route = createFileRoute("/api/studio/generate-stream")({
  server: {
    handlers: {
      POST: handleGenerateStream,
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

async function handleGenerateStream({ request }: { request: Request }): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const accepted = await executeGenerationCortex({
      request,
      promptPayload: body,
    });
    return Response.json(
      {
        ok: true,
        success: true,
        message: accepted.message,
        correlationId: accepted.correlationId,
        queueId: accepted.queueId,
        jobId: accepted.queueId,
        vaultId: accepted.vaultId,
        userId: accepted.userId,
        status: accepted.status,
        balance: accepted.balance,
        tokenBypassed: accepted.tokenBypassed,
      },
      {
        status: 202,
        headers: { "x-correlation-id": accepted.correlationId },
      },
    );
  } catch (error) {
    return cortexErrorResponse(error);
  }
}
