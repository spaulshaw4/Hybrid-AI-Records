/**
 * WhatsApp video call for live vocal sessions.
 *
 * Every "Build a track" brief that books a live vocal call gets its own session
 * reference the moment the call step is reached. The reference travels through
 * the order notes and the WhatsApp deep link, so the artist can start the video
 * call with the studio desk without waiting for anything to be sent.
 */

/** Founder desk WhatsApp number — kept in sync with CONTACTS[0]. */
const STUDIO_WHATSAPP = "16184793630";

const ROOM_PREFIX = "HAR-Vocals";

/** Random, unguessable session reference (no personal data in the link). */
export function generateCallRoom(): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${ROOM_PREFIX}-${rand.slice(0, 12)}`;
}

export function meetingLinkForRoom(room: string, artistPhone?: string): string {
  const from = artistPhone?.trim() ? ` My WhatsApp: ${artistPhone.trim()}.` : "";
  const text = `Hi Hybrid AI Records — I'm ready for my vocal video call. Session ref: ${room}.${from}`;
  return `https://wa.me/${STUDIO_WHATSAPP}?text=${encodeURIComponent(text)}`;
}

/** Short, plain-English joining instructions shown wherever the link appears. */
export const CALL_INSTRUCTIONS = [
  "Tap the button to open WhatsApp and message the studio desk — your session ref is prefilled.",
  "At your session time we start the WhatsApp video call from that chat.",
  "Make sure WhatsApp is installed and your number is the one you use for the call.",
  "Join from a quiet room and use wired headphones to stop echo.",
  "Be ready 5 minutes early; sessions run 60–90 minutes and are English only.",
] as const;


export type VocalCallHandoff = {
  meetingLink: string;
  date: string;
  altDate: string;
  window: string;
  timezone: string;
};

const HANDOFF_KEY = "har.vocal-call.handoff";

/** Stash the call details so the confirmation page can repeat them after payment. */
export function saveCallHandoff(handoff: VocalCallHandoff): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    /* storage unavailable — the link still lives in the order notes */
  }
}

export function loadCallHandoff(): VocalCallHandoff | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<VocalCallHandoff>;
    if (!parsed || typeof parsed.meetingLink !== "string" || !parsed.meetingLink) return null;
    return {
      meetingLink: parsed.meetingLink,
      date: typeof parsed.date === "string" ? parsed.date : "",
      altDate: typeof parsed.altDate === "string" ? parsed.altDate : "",
      window: typeof parsed.window === "string" ? parsed.window : "",
      timezone: typeof parsed.timezone === "string" ? parsed.timezone : "",
    };
  } catch {
    return null;
  }
}

export function clearCallHandoff(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY);
  } catch {
    /* ignore */
  }
}
