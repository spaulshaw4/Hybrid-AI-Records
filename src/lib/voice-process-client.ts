/**
 * Optional HeartMuLa vocal pass. Fired beside Lyria and never awaited by it.
 * No recording, or an empty script, means this module does not call the API.
 */

export function shouldProcessVoice(
  blob: Blob | File | null | undefined,
  lyrics: string,
): boolean {
  return Boolean(blob && blob.size > 64 && lyrics.trim());
}

function fileForTake(blob: Blob): File {
  if (blob instanceof File) return blob;
  const type = blob.type || "audio/wav";
  const ext = type.includes("webm")
    ? "webm"
    : type.includes("mpeg") || type.includes("mp3")
      ? "mp3"
      : "wav";
  return new File([blob], `mic_take.${ext}`, { type });
}

/** POST the take. Failures resolve to null so Generate Track keeps going. */
export function requestVoiceProcess(blob: Blob, lyrics: string): Promise<null> {
  const script = lyrics.trim();
  if (!shouldProcessVoice(blob, script)) return Promise.resolve(null);
  const body = new FormData();
  body.append("file", fileForTake(blob));
  body.append("lyrics", script);
  return fetch("/api/voice/process", { method: "POST", body })
    .then(() => null)
    .catch(() => null);
}
