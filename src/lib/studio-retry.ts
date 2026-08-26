/**
 * Client-side retry + error messaging for the /studio generation pipeline.
 *
 * The server already retries individual HTTP calls to the engine. This layer
 * handles the failures that survive that: a whole generation attempt that
 * errors or times out, and an audio URL that comes back unfetchable.
 */

export type EngineErrorKind =
  | "offline"
  | "auth"
  | "credit"
  | "unavailable"
  | "timeout"
  | "generation"
  | "audio"
  | "unknown";

export type EngineErrorInfo = {
  kind: EngineErrorKind;
  /** Message safe to show the user. */
  message: string;
  /** Whether another attempt has a reasonable chance of succeeding. */
  retryable: boolean;
};

/** Max full generation attempts (1 initial + retries). */
export const MAX_GENERATION_ATTEMPTS = 3;
/** Backoff between whole-generation retries. */
export const GENERATION_RETRY_DELAYS_MS = [4000, 10000];
/** Attempts when verifying/fetching the returned audio URL. */
export const MAX_AUDIO_ATTEMPTS = 3;

export function classifyEngineError(error: unknown): EngineErrorInfo {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.toLowerCase();

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return {
      kind: "offline",
      message: "This device is offline — reconnect and we'll pick the generation back up.",
      retryable: true,
    };
  }
  if (text.includes("unauthorized") || text.includes("reauthorized") || text.includes("401")) {
    return {
      kind: "auth",
      message: "Your session or the engine connection expired. Sign in again, then retry.",
      retryable: false,
    };
  }
  if (text.includes("no credit") || text.includes("billing") || text.includes("402")) {
    return {
      kind: "credit",
      message: "The music engine account is out of credit, so the track can't be rendered right now.",
      retryable: false,
    };
  }
  if (text.includes("engine busy") || text.includes("token refunded")) {
    return {
      kind: "unavailable",
      message: "Engine busy, token refunded",
      retryable: true,
    };
  }
  if (text.includes("temporarily unavailable") || text.includes("temporarily unreachable") || text.includes("failed to fetch") || text.includes("network") || text.includes("stream dropped")) {
    return {
      kind: "unavailable",
      message: "The music engine is temporarily unreachable. Retrying automatically…",
      retryable: true,
    };
  }
  if (text.includes("timed out") || text.includes("timeout") || text.includes("did not return audio")) {
    return {
      kind: "timeout",
      message: "The engine took too long to return audio. Retrying automatically…",
      retryable: true,
    };
  }
  if (text.includes("audio")) {
    return {
      kind: "audio",
      message: "The finished track couldn't be downloaded. Retrying the audio fetch…",
      retryable: true,
    };
  }
  if (text.includes("generation failed") || text.includes("canceled")) {
    return {
      kind: "generation",
      message: "The engine rejected this render. Retrying with the same brief…",
      retryable: true,
    };
  }
  return {
    kind: "unknown",
    message: raw ? `Generation failed: ${raw}` : "Generation failed for an unknown reason.",
    retryable: true,
  };
}

/** Final, non-retrying copy shown once every attempt is used up. */
export function finalErrorMessage(info: EngineErrorInfo, attempts: number): string {
  if (!info.retryable) return info.message;
  const base = info.message.replace(/\s*Retrying[^.]*…\s*$/i, "").trim();
  return `${base} We tried ${attempts} ${attempts === 1 ? "time" : "times"} — your Hybrid Token has not been re-charged, so you can run it again.`;
}

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Confirms the returned audio URL is actually fetchable before we hand it to
 * the player, so a dead CDN link surfaces as a clear error instead of a
 * silently broken <audio> element.
 */
export async function verifyAudioUrl(
  url: string,
  attempts: number = MAX_AUDIO_ATTEMPTS,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const proxyUrl = `/api/public/audio-proxy?url=${encodeURIComponent(url)}`;
      const response = await fetch(proxyUrl, { method: "GET", headers: { Range: "bytes=0-4095" } });
      const type = response.headers.get("content-type") ?? "";
      if ((response.ok || response.status === 206) && type.startsWith("audio/")) return true;
    } catch {
      /* fall through to retry */
    }
    if (attempt < attempts) await wait(1500 * attempt);
  }
  return false;
}
