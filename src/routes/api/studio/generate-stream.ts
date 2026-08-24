import { createFileRoute } from "@tanstack/react-router";
import {
  parseGenerateEngineTrackInput,
  runGenerateEngineTrack,
} from "@/lib/apiframe-music.functions";
import { createGenerateSseResponse } from "@/lib/studio-generate-stream.server";
import { studioUserIdFromRequestOrDev } from "@/lib/studio-request-auth.server";

/**
 * POST /api/studio/generate-stream
 *
 * SSE generate with keepalives so long Demucs / CWALO / Gate 1 waits do not
 * surface as browser "Failed to fetch" on idle HTTP connections.
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
  let userId: string | null;
  try {
    userId = await studioUserIdFromRequestOrDev(request);
  } catch {
    return Response.json({ error: "Sign in to generate a track." }, { status: 401 });
  }
  if (!userId) {
    return Response.json({ error: "Sign in to generate a track." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  let data: ReturnType<typeof parseGenerateEngineTrackInput>;
  try {
    data = parseGenerateEngineTrackInput(body);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid generate payload." },
      { status: 400 },
    );
  }

  const { tryGetSupabaseAdmin, createSupabaseUserClient } = await import(
    "@/integrations/supabase/client.server"
  );
  const authHeader = request.headers.get("authorization");
  const token =
    authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  const supabase = tryGetSupabaseAdmin() ?? createSupabaseUserClient(token);

  return createGenerateSseResponse({
    run: () => runGenerateEngineTrack(data, { userId: userId!, supabase }),
  });
}
