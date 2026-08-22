/**
 * Turns a raw engine/server error into a precise, user-readable explanation.
 *
 * The studio used to show one generic sentence ("Generation error detected")
 * for every failure, which made it impossible to tell a rejected payload from
 * a slow render that simply outran the connection window. This module keeps
 * that vocabulary in one place so the banner, the toast and the run history
 * all say the same, specific thing.
 */

export type EngineFailureKind =
  | "cancelled"
  | "credits"
  | "payload"
  | "timeout"
  | "network"
  | "auth"
  | "storage"
  | "unknown";

export type EngineFailure = {
  kind: EngineFailureKind;
  /** Full sentence shown in the banner. */
  message: string;
  /** Short label for toasts and history rows. */
  headline: string;
  /** Whether running the same brief again is likely to help. */
  retryable: boolean;
};

const TOKEN_SAFE = "Your Hybrid Token was not charged.";

function hasHttpStatus(lower: string, code: number): boolean {
  return new RegExp(`\\b${code}\\b`).test(lower);
}

export function explainEngineFailure(raw: unknown): EngineFailure {
  const text = (raw instanceof Error ? raw.message : String(raw ?? "")).trim();
  const lower = text.toLowerCase();

  if (lower.includes("canceled") || lower.includes("cancelled")) {
    return {
      kind: "cancelled",
      headline: "Render canceled",
      message: `Render canceled. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (lower.includes("unauthorized") || hasHttpStatus(lower, 401) || lower.includes("sign in")) {
    return {
      kind: "auth",
      headline: "Session expired",
      message: `Your session expired before the render finished. Sign in again and retry. ${TOKEN_SAFE}`,
      retryable: false,
    };
  }

  if (lower.includes("invalid audio")) {
    return {
      kind: "storage",
      headline: "The track could not be saved",
      message: `The audio came back in a format we could not store. Retry the render. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (lower.includes("lyrics are required")) {
    return {
      kind: "payload",
      headline: "Lyrics are missing",
      message: `Add lyrics (or a title so we can write them) and run it again. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (
    lower.includes("out of range") ||
    lower.includes("too small") ||
    lower.includes("too big") ||
    lower.includes("track setup:") ||
    (lower.includes("control") && (lower.includes("invalid") || lower.includes("range")))
  ) {
    return {
      kind: "payload",
      headline: "The engine rejected this brief",
      message: `${text || "A prompt, lyric or control value was out of range."} ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (
    lower.includes("took too long") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("still rendering")
  ) {
    return {
      kind: "timeout",
      headline: "The render outran the connection window",
      message: `The render is taking longer than the connection window allows — this is a server timeout, not a problem with your brief. Use Retry to reconnect to the render that is still running. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("offline") ||
    hasHttpStatus(lower, 502) ||
    hasHttpStatus(lower, 503) ||
    hasHttpStatus(lower, 504)
  ) {
    return {
      kind: "network",
      headline: "Lost the connection to the engine",
      message: `The connection to the engine dropped mid-render. Your render may still be running — use Retry to reconnect. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (lower.startsWith("music engine:") || hasHttpStatus(lower, 422) || hasHttpStatus(lower, 400)) {
    return {
      kind: "payload",
      headline: "The music engine rejected this request",
      message: `${text} ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  if (lower.includes("storage") || lower.includes("archive") || lower.includes("save")) {
    return {
      kind: "storage",
      headline: "The track could not be saved",
      message: `The audio rendered but saving it to your vault failed. Retry saving — no re-render is needed. ${TOKEN_SAFE}`,
      retryable: true,
    };
  }

  return {
    kind: "unknown",
    headline: "Generation error detected",
    message: text
      ? `Generation error detected: ${text} ${TOKEN_SAFE}`
      : `Generation error detected. ${TOKEN_SAFE}`,
    retryable: true,
  };
}
