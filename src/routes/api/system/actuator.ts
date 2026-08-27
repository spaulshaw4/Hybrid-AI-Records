import { createFileRoute } from "@tanstack/react-router";
import {
  authorizeActuatorCommand,
  executeActuatorCommand,
  readActuatorHealth,
} from "@/lib/pipeline-actuator.server";

/**
 * GET  /api/system/actuator — health + queue backlog (Actuator readouts)
 * POST /api/system/actuator — admin commands (FLUSH_STUCK_JOBS, KICK_WORKER)
 *
 * POST requires `ADMIN_ACTUATOR_SECRET` via JSON `secretKey`, Bearer, or query.
 */
export const Route = createFileRoute("/api/system/actuator")({
  server: {
    handlers: {
      GET: handleHealth,
      POST: handleCommand,
      PUT: () => methodNotAllowed(),
      DELETE: () => methodNotAllowed(),
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { allow: "GET, POST" },
  });
}

async function handleHealth(): Promise<Response> {
  const health = await readActuatorHealth();
  const status = health.status === "HEALTHY" ? 200 : 500;
  return Response.json(health, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function handleCommand({ request }: { request: Request }): Promise<Response> {
  let body: { command?: string; secretKey?: string; state?: string } = {};
  try {
    body = (await request.json()) as {
      command?: string;
      secretKey?: string;
      state?: string;
    };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const auth = authorizeActuatorCommand({
    request,
    bodySecret: body.secretKey,
  });
  if (!auth.ok) {
    return Response.json({ error: auth.error }, { status: auth.status });
  }

  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) {
    return Response.json({ error: "Missing actuator command." }, { status: 400 });
  }

  const result = await executeActuatorCommand(command, {
    state: body.state,
    secretKey: body.secretKey,
  });
  if (!result.success && result.error === "unknown_command") {
    return Response.json({ error: result.message }, { status: 400 });
  }
  if (!result.success) {
    const status = result.error === "activator_switch_failed" ? 401 : 500;
    return Response.json(result, { status });
  }
  return Response.json(result, { status: 200 });
}
