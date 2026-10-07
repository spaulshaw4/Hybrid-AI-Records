import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import {
  fetchWaveSpeedPrediction,
  findVaultedTrack,
  isTerminalWaveSpeedStatus,
  storeVaultedMaster,
  waveSpeedAudioUrl,
  waveSpeedResultMeta,
  waveSpeedResultStatus,
} from "@/app/api/generate/route";

const TASK_ID = /^[A-Za-z0-9_-]+$/;

type SyncBody = { statusCode: number; body: Record<string, unknown> };

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

function hasBearer(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice("Bearer ".length).trim().length > 0;
}

function taskIdFrom(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  if (typeof record.taskId === "string" && record.taskId.trim()) return record.taskId.trim();
  if (typeof record.id === "string" && record.id.trim()) return record.id.trim();
  return "";
}

function publicError(message: string): string {
  if (!message || /https?:|bearer|eyJ|service_role|api[_-]?key/i.test(message)) {
    return "Generation failed upstream";
  }
  return message;
}

/**
 * Import one finished WaveSpeed prediction into vaulted_tracks.
 * Polls the v3 result endpoint. Does not trust a URL from the request body.
 */
export async function syncVaultTask(userId: string, taskId: string): Promise<SyncBody> {
  let poll: unknown;
  try {
    poll = await fetchWaveSpeedPrediction(taskId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    if (message === "Missing API key") {
      return { statusCode: 500, body: { error: "Missing API key" } };
    }
    return { statusCode: 502, body: { error: publicError(message) } };
  }

  const status = waveSpeedResultStatus(poll);
  if (isTerminalWaveSpeedStatus(status)) {
    return {
      statusCode: 200,
      body: { success: false, status, error: "Generation failed upstream" },
    };
  }
  if (status !== "completed") {
    return { statusCode: 200, body: { success: false, status: status || "processing" } };
  }

  const outputUrl = waveSpeedAudioUrl(poll);
  if (!outputUrl.startsWith("https://")) {
    return { statusCode: 422, body: { error: "Generation failed upstream" } };
  }

  try {
    const existing = await findVaultedTrack(userId, taskId);
    if (existing) {
      return {
        statusCode: 200,
        body: {
          success: true,
          status: "completed",
          taskId,
          wavUrl: existing.wavUrl,
          mp3Url: existing.mp3Url,
        },
      };
    }

    const meta = waveSpeedResultMeta(poll);
    const urls = await storeVaultedMaster({
      taskId,
      userId,
      title: meta.title,
      prompt: meta.prompt,
      lyrics: meta.lyrics,
      outputUrl,
    });
    return {
      statusCode: 200,
      body: {
        success: true,
        status: "completed",
        taskId,
        wavUrl: urls.wavUrl,
        mp3Url: urls.mp3Url,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    if (message.startsWith("Missing NEXT_PUBLIC_SUPABASE_URL")) {
      return { statusCode: 500, body: { error: message } };
    }
    return { statusCode: 502, body: { error: publicError(message) } };
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!hasBearer(req)) {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let userId = "";
  try {
    const session = await resolveStudioSession(req);
    userId = session.userId.trim();
  } catch (err: unknown) {
    if (isUnauthorized(err)) {
      return Response.json({ error: "Unauthorized session" }, { status: 401 });
    }
    const message = err instanceof Error ? err.message : "Unauthorized session";
    return Response.json({ error: publicError(message) }, { status: 500 });
  }
  if (!userId || userId === "guest_user") {
    return Response.json({ error: "Unauthorized session" }, { status: 401 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid task id" }, { status: 400 });
  }
  const taskId = taskIdFrom(body);
  if (!taskId || !TASK_ID.test(taskId)) {
    return Response.json({ error: "Invalid task id" }, { status: 400 });
  }

  const result = await syncVaultTask(userId, taskId);
  return Response.json(result.body, { status: result.statusCode });
}
