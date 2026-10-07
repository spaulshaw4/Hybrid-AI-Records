/** Poll our status route until a full track is vaulted. The server watcher uses the same 60-minute deadline. */

export const TRACK_POLL_INTERVAL_MS = 5000;
export const TRACK_POLL_DEADLINE_MS = 60 * 60 * 1000;

export type VaultedTrackUrls = {
  wavUrl: string;
  mp3Url: string;
};

type TrackStatusBody = {
  status?: string;
  wavUrl?: string;
  mp3Url?: string;
  error?: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForVaultedTrack(
  taskId: string,
  options?: { signal?: AbortSignal; intervalMs?: number; deadlineMs?: number },
): Promise<VaultedTrackUrls> {
  const intervalMs = options?.intervalMs ?? TRACK_POLL_INTERVAL_MS;
  const deadlineMs = options?.deadlineMs ?? TRACK_POLL_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs, options?.signal);
    const res = await fetch(`/api/ai/wavespeed-webhook?taskId=${encodeURIComponent(taskId)}`, {
      signal: options?.signal,
    });
    const data = (await res.json().catch(() => ({}))) as TrackStatusBody;
    if (data.status === "completed" && data.wavUrl && data.mp3Url) {
      return { wavUrl: data.wavUrl, mp3Url: data.mp3Url };
    }
    if (data.status === "failed" || data.status === "missing" || res.status === 404) {
      throw new Error(data.error || "Generation failed upstream");
    }
  }
  throw new Error("Task hit the 60-minute engine ceiling");
}
