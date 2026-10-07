/**
 * Pending vocal jobs live only in this process.
 * The map is dropped on restart; the webhook then stores the file and skips the vault row.
 */

export type VocalJob = {
  taskId: string;
  userId: string;
  title: string;
  lyrics: string;
  tags: string;
};

const jobs = new Map<string, VocalJob>();

export function rememberVocalJob(job: VocalJob): void {
  jobs.set(job.taskId, job);
}

export function readVocalJob(taskId: string): VocalJob | undefined {
  return jobs.get(taskId);
}

export function resetVocalJobs(): void {
  jobs.clear();
}
