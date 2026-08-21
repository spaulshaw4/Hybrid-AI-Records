/**
 * The artist's currently selected cloned voice. Persisted in the browser so
 * the Voice Library panel and the generator stay in sync across reloads.
 */
export const ACTIVE_VOICE_KEY = "hybrid.studio.activeVoiceId";
export const ACTIVE_VOICE_EVENT = "hybrid:active-voice";

export function notifyActiveVoiceChange() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ACTIVE_VOICE_EVENT));
}
