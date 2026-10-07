import { readTrackJob } from "@/lib/wavespeed-track-jobs.server";
import { settleTrackFromWaveSpeed } from "@/app/api/generate/route";

function taskIdFrom(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;
  const id = nested?.id ?? record.id;
  return typeof id === "string" ? id.trim() : "";
}

/**
 * Browser status poll for a full track.
 * WaveSpeed does not POST here. The background watcher reads the prediction result.
 * POST remains so a known task can still be settled from that same result poll.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const taskId = taskIdFrom(body);
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId) || !readTrackJob(taskId)) {
    return Response.json({ received: true });
  }
  try {
    await settleTrackFromWaveSpeed(taskId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    console.error("[wavespeed-webhook]", message || "error");
  }
  return Response.json({ received: true });
}

export async function GET(req: Request): Promise<Response> {
  const taskId = new URL(req.url).searchParams.get("taskId")?.trim() ?? "";
  if (!taskId || !/^[A-Za-z0-9_-]+$/.test(taskId)) {
    return Response.json({ error: "Unknown task" }, { status: 400 });
  }
  const job = readTrackJob(taskId);
  if (!job) {
    return Response.json({ status: "missing", error: "Unknown task" }, { status: 404 });
  }
  return Response.json({
    status: job.status,
    taskId: job.taskId,
    wavUrl: job.wavUrl,
    mp3Url: job.mp3Url,
    error: job.error,
  });
}
