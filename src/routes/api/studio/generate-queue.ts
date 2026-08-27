import { createFileRoute } from "@tanstack/react-router";
import {
  cortexErrorResponse,
  executeGenerationCortex,
} from "@/lib/cortex-dispatcher.server";

/**
 * POST /api/studio/generate-queue
 *
 * Cortex entrypoint: Gate 1 (identity + token) → Gate 2 (queue) → Gate 3 vault
 * row opened for the caller. Worker completes shared-key execution + delivery.
 */
export const Route = createFileRoute("/api/studio/generate-queue")({
  server: {
    handlers: {
      POST: handleEnqueue,
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

async function handleEnqueue({ request }: { request: Request }): Promise<Response> {
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
