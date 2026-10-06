/**
 * In-process record of full-track renders submitted to WaveSpeed.
 * The webhook and the background watcher both finish the same task id,
 * so delivery is claimed once.
 */

export const WAVESPEED_TRACK_WEBHOOK_URL =
  "https://hybrid-ai-records.com/api/ai/wavespeed-webhook";

export type TrackJobStatus = "processing" | "completed" | "failed";

export type TrackJob = {
  taskId: string;
  title: string;
  prompt: string;
  lyrics: string | null;
  vocalId: string | null;
  userId: string;
  status: TrackJobStatus;
  delivering: boolean;
  wavUrl?: string;
  mp3Url?: string;
  error?: string;
};

const jobs = new Map<string, TrackJob>();

export function rememberTrackJob(job: TrackJob): void {
  jobs.set(job.taskId, job);
}

export function readTrackJob(taskId: string): TrackJob | undefined {
  return jobs.get(taskId);
}

/** Claim the WAV download. A second caller gets null while the first is in flight or finished. */
export function beginDelivery(taskId: string): TrackJob | null {
  const job = jobs.get(taskId);
  if (!job || job.status !== "processing" || job.delivering) return null;
  job.delivering = true;
  return job;
}

export function completeTrackJob(
  taskId: string,
  urls: { wavUrl: string; mp3Url: string },
): void {
  const job = jobs.get(taskId);
  if (!job) return;
  job.status = "completed";
  job.delivering = false;
  job.wavUrl = urls.wavUrl;
  job.mp3Url = urls.mp3Url;
  job.error = undefined;
}

export function failTrackJob(taskId: string, error: string): void {
  const job = jobs.get(taskId);
  if (!job || job.status !== "processing") return;
  job.status = "failed";
  job.delivering = false;
  job.error = error;
}

export function resetTrackJobs(): void {
  jobs.clear();
}
