export type VocalSourceMode = "default-ai" | "custom-upload";
export type VocalLiabilityAction = "record" | "upload";

export const VOCAL_SOURCE_NAME = "vocal-mode";
export const VOCAL_CONSENT_CHECK_ID = "vocal-consent-check";
export const VOCAL_CONSENT_MODAL_CHECK_ID = "vocal-consent-modal-check";
/** Session-only flag — must match `sessionStorage.getItem('vocal_liability_accepted') === 'true'`. */
export const VOCAL_LIABILITY_SESSION_KEY = "vocal_liability_accepted";

export const VOCAL_LIABILITY_MODAL_TITLE = "Legal Acknowledgment Required";

export const VOCAL_LIABILITY_MODAL_BODY =
  "You are about to use a custom voice file or recording. You acknowledge and agree that you hold sole legal responsibility for any voice, audio file, or likeness you upload or record. You warrant that you have explicit consent or rights to use any uploaded or recorded voice samples, and you understand that unauthorized use of another artist's identity or likeness may result in civil or criminal liability for which you are solely responsible.";

export const VOCAL_LIABILITY_CHECKBOX_LABEL = "I accept full legal responsibility";

/** Longer warranty used on the generate/API path. */
export const VOCAL_CONSENT_COPY = VOCAL_LIABILITY_MODAL_BODY;

export const VOCAL_CONSENT_BLOCK_MESSAGE =
  "You must acknowledge the legal liability disclaimer before recording or uploading vocal stems.";

export const VOCAL_CONSENT_GENERATE_MESSAGE =
  "Action Blocked: You must acknowledge the legal liability disclaimer to use custom-cloned or uploaded vocal files.";

export const VOCAL_CONSENT_REQUIRED_MESSAGE =
  "Legal disclaimer must be accepted to process custom voice cloning.";

/** Form/JSON flags: true, "true", "1", "on", "yes". */
export function parseTermsAccepted(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes";
}

export function readStoredVocalConsent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(VOCAL_LIABILITY_SESSION_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeStoredVocalConsent(accepted: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (accepted) {
      window.sessionStorage.setItem(VOCAL_LIABILITY_SESSION_KEY, "true");
    } else {
      window.sessionStorage.removeItem(VOCAL_LIABILITY_SESSION_KEY);
    }
  } catch {
    /* private mode — consent stays in memory */
  }
}
