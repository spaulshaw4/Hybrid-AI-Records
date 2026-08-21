/**
 * Turns raw AI/provider failures into clean, user-safe messages.
 *
 * Auth failures (401/403, OAuth/UNAUTHENTICATED text) must never bubble raw
 * provider payloads into the UI — they leak provider internals and read like a
 * crash to the user.
 */
export function friendlyAiError(error: unknown, label: string): Error {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const text = raw.toLowerCase();

  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("unauthenticated") ||
    text.includes("unauthorized") ||
    text.includes("invalid authentication credentials") ||
    text.includes("oauth 2 access token") ||
    text.includes("api key")
  ) {
    return new Error(
      `${label} could not authenticate with the AI service. Nothing was charged — please try again, and if it keeps failing the API credentials need to be refreshed.`,
    );
  }

  if (text.includes("429") || text.includes("rate limit") || text.includes("busy")) {
    return new Error(`${label} is busy right now. Try again in a moment.`);
  }

  if (text.includes("402") || text.includes("credit")) {
    return new Error("AI credits are exhausted. Add credits and try again.");
  }

  if (text.includes("timed out") || text.includes("timeout") || text.includes("abort")) {
    return new Error(`${label} timed out. Try again with a shorter brief.`);
  }

  return new Error(raw.trim() ? `${label} failed: ${raw.slice(0, 300)}` : `${label} failed. Please try again.`);
}
