/**
 * Shared vocabulary for "the render account is out of platform credits".
 *
 * Hybrid Tokens are the artist's balance; platform (Replicate) credits are what
 * actually pays for a render. The two are separate meters, so an account can
 * hold tokens while the engine itself cannot run. This module gives both sides
 * of the wire one way to detect and phrase that case, so nobody is charged a
 * token for a render that never started.
 */

export const ENGINE_CREDIT_CODE = "ENGINE_CREDITS_EXHAUSTED";

export const ENGINE_CREDIT_MESSAGE =
  "Hybrid Engine platform credits are exhausted, so no render can start right now. Your Hybrid Tokens were not spent — they stay on your balance until a track actually renders.";

/** Wire format: the code prefix survives the server-function error boundary. */
export function engineCreditErrorMessage(detail?: string | null): string {
  return `${ENGINE_CREDIT_CODE}: ${detail?.trim() || ENGINE_CREDIT_MESSAGE}`;
}

export function isEngineCreditsError(input: unknown): boolean {
  const text =
    input instanceof Error ? input.message : typeof input === "string" ? input : "";
  if (!text) return false;
  if (text.includes(ENGINE_CREDIT_CODE)) return true;
  return CREDIT_PHRASES.some((phrase) => text.toLowerCase().includes(phrase));
}

const CREDIT_PHRASES = [
  "insufficient credit",
  "credits are exhausted",
  "credit are exhausted",
  "out of credit",
  "no credit",
  "payment required",
  "quota exceeded",
  "billing",
];

/** True when a provider response body/status is really a credit exhaustion. */
export function looksLikeCreditExhaustion(status: number, body: string): boolean {
  if (status === 402) return true;
  if (status !== 400 && status !== 403 && status !== 429 && status !== 500) return false;
  return isEngineCreditsError(body);
}

/** Strips the wire code so the UI shows a clean sentence. */
export function readableEngineError(message: string): string {
  if (!message.includes(ENGINE_CREDIT_CODE)) return message;
  const detail = message.split(`${ENGINE_CREDIT_CODE}:`).pop()?.trim();
  return detail && detail.length > 0 ? detail : ENGINE_CREDIT_MESSAGE;
}
