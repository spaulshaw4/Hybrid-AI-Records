/**
 * Client-safe helpers for surfacing AI rate-limit / quota failures.
 *
 * Server code tags quota failures with QUOTA_MARKER (see `ai-error.server`),
 * so the UI can tell "the model is busy / out of quota for now" apart from a
 * real bug and show a calm, friendly state instead of a raw HTTP dump.
 */

import { toast } from "sonner";

/** Marker embedded in server error messages for rate-limit / quota failures. */
export const QUOTA_MARKER = "[ai-quota]";

export const QUOTA_EVENT = "hybrid:ai-quota";

/** True when an error message came from a 429 / quota-exhausted upstream. */
export function isQuotaError(message: unknown): boolean {
  if (typeof message !== "string") return false;
  const text = message.toLowerCase();
  return (
    message.includes(QUOTA_MARKER) ||
    text.includes("rate limit") ||
    text.includes("rate-limited") ||
    text.includes("quota") ||
    text.includes("[429]") ||
    text.includes("resource_exhausted")
  );
}

/** Friendly, non-technical copy for a quota failure. */
export const QUOTA_HEADLINE = "The AI is at its rate limit right now";
export const QUOTA_BODY =
  "Your AI key hit its per-minute or daily quota. Nothing was charged and no work was lost — " +
  "wait about a minute and run it again, or raise the quota on your key.";

/** Strips internal markers so nothing cryptic reaches the user. */
export function cleanErrorMessage(message: string): string {
  return message.replaceAll(QUOTA_MARKER, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Shows an AI failure to the user: a calm quota notice when the upstream is
 * rate limited, the plain error otherwise. Also broadcasts a window event so
 * any mounted quota banner can switch into its cooldown state.
 */
export function showAiError(message: string, fallback = "Something went wrong. Try again.") {
  const clean = cleanErrorMessage(message) || fallback;
  if (isQuotaError(message)) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(QUOTA_EVENT, { detail: clean }));
    }
    toast.error(QUOTA_HEADLINE, { description: QUOTA_BODY });
    return;
  }
  toast.error(clean);
}
