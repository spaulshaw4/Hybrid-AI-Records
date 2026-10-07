import { failTrackJob, readTrackJob } from "@/lib/wavespeed-track-jobs.server";
import { settleTrackFromWaveSpeed } from "@/app/api/generate/route";

/** settle throws this when a completed task has no usable https audio URL. */
function completedWithoutHttpsAudio(message: string): boolean {
  return /no audio URL found/i.test(message);
}

function thrownMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return typeof err === "string" ? err : "";
}

/** Non-https URL embedded in settle's error, or "(missing)" when none was returned. */
function invalidAudioUrl(message: string): string {
  const match = message.match(/https?:\/\/[^\s"'<>\\]+/i);
  if (match && !match[0].toLowerCase().startsWith("https://")) return match[0];
  return "(missing)";
}

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
    const message = thrownMessage(err);
    console.error("[wavespeed-webhook]", message || "error");
    // Missing or non-https output is a finished bad result. Fail the in-memory
    // job before returning. settle still throws for an empty URL so a direct
    // watcher call can leave the job processing and poll again.
    if (completedWithoutHttpsAudio(message)) {
      console.warn("[wavespeed-webhook] invalid audio URL:", invalidAudioUrl(message));
      failTrackJob(taskId, "Generation failed upstream");
      return Response.json(
        { error: "Generation failed upstream: non-https or invalid audio URL" },
        { status: 400 },
      );
    }
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
