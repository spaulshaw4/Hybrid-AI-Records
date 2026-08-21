/**
 * Single-track creative brief.
 *
 * The "Build a track" flow collects the direction our studio needs before a
 * track is produced — genre, reference songs, tempo/key, and deliverable
 * preferences. The finished brief travels with the order as structured notes.
 */

import {
  CALL_INSTRUCTIONS,
  generateCallRoom,
  meetingLinkForRoom,
} from "./vocal-call-link";

export type TrackBrief = {
  workingTitle: string;
  genre: string;
  /** Secondary flavours: "drill", "soul sample", "spanish guitar". */
  subGenres: string[];
  mood: string;
  language: string;
  /** Reference songs / artists, one per line. */
  references: string[];
  tempoBpm: number | null;
  tempoFeel: string;
  key: string;
  vocals: string;
  /** Preferred date for the live video-chat vocal call (YYYY-MM-DD). */
  callDate: string;
  /** Backup date if the first choice is taken. */
  callAltDate: string;
  /** Preferred time window on the chosen day. */
  callWindow: string;
  /** IANA timezone the windows are expressed in. */
  callTimezone: string;
  /** Auto-generated video-chat room id for the live vocal session. */
  callRoom: string;
  /** International dial code for the artist's WhatsApp number, e.g. "+1". */
  callPhoneCountry: string;
  /** Digits of the artist's WhatsApp number, without the dial code. */
  callPhoneNumber: string;
  /** Required tick before a live session can be booked. */
  callRecordConsent: boolean;
  /** What we capture during the session. */
  callCapture: string;
  /** How long raw session takes are kept before deletion. */
  callRetention: string;
  /** Opt-in: allow clips of the session to be used in promo content. */
  callPromoConsent: boolean;
  /** Opt-in: allow other team members to sit in on the call. */
  callGuestsAllowed: boolean;
  /** Deliverable formats requested. */
  deliverables: string[];
  stems: boolean;
  radioEdit: boolean;
  instrumental: boolean;
  notes: string;
};

export const GENRES = [
  "Hip-Hop / Rap",
  "R&B / Soul",
  "Trap",
  "Drill",
  "Afrobeats",
  "Pop",
  "Rock",
  "Country",
  "Electronic / EDM",
  "Gospel",
  "Latin",
  "Other",
] as const;

export const TEMPO_FEELS = ["Slow / laid back", "Mid tempo", "Uptempo", "Double time"] as const;

// Artists cannot record and send their own vocals — vocals are captured with us
// on a live video-chat session, and sessions are English only.
export const VOCAL_OPTIONS = [
  "Live video-chat vocal session with our team (English only)",
  "AI vocals (Hybrid AI)",
  "Instrumental only",
] as const;

/** Time windows we run live vocal sessions in (artist's local time). */
export const CALL_WINDOWS = [
  "Morning (9:00 – 12:00)",
  "Midday (12:00 – 15:00)",
  "Afternoon (15:00 – 18:00)",
  "Evening (18:00 – 21:00)",
  "Late (21:00 – 23:00)",
] as const;

/** Small curated timezone list; the browser zone is added on top at runtime. */
export const CALL_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Vilnius",
  "Europe/Berlin",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
] as const;

/** Common dial codes; the list stays short and searchable on mobile. */
export const CALL_DIAL_CODES = [
  { code: "+1", label: "+1 · US / Canada" },
  { code: "+44", label: "+44 · United Kingdom" },
  { code: "+353", label: "+353 · Ireland" },
  { code: "+61", label: "+61 · Australia" },
  { code: "+27", label: "+27 · South Africa" },
  { code: "+234", label: "+234 · Nigeria" },
  { code: "+233", label: "+233 · Ghana" },
  { code: "+254", label: "+254 · Kenya" },
  { code: "+265", label: "+265 · Malawi" },
  { code: "+370", label: "+370 · Lithuania" },
  { code: "+49", label: "+49 · Germany" },
  { code: "+33", label: "+33 · France" },
  { code: "+34", label: "+34 · Spain" },
  { code: "+39", label: "+39 · Italy" },
  { code: "+31", label: "+31 · Netherlands" },
  { code: "+351", label: "+351 · Portugal" },
  { code: "+55", label: "+55 · Brazil" },
  { code: "+52", label: "+52 · Mexico" },
  { code: "+91", label: "+91 · India" },
  { code: "+971", label: "+971 · UAE" },
  { code: "+81", label: "+81 · Japan" },
  { code: "+63", label: "+63 · Philippines" },
] as const;

/** Digits only, no leading zero, 6–15 digits (E.164 without the dial code). */
export function normalizePhoneDigits(input: string): string {
  return input.replace(/\D/g, "").replace(/^0+/, "").slice(0, 15);
}

export function phoneReady(b: TrackBrief): boolean {
  const digits = normalizePhoneDigits(b.callPhoneNumber);
  return /^\+\d{1,4}$/.test(b.callPhoneCountry.trim()) && digits.length >= 6 && digits.length <= 15;
}

/** Full E.164 number used in the prefilled WhatsApp message. */
export function callPhoneE164(b: TrackBrief): string {
  const digits = normalizePhoneDigits(b.callPhoneNumber);
  return digits ? `${b.callPhoneCountry.trim()}${digits}` : "";
}

/** What is captured on the call. */
export const CALL_CAPTURE_OPTIONS = [
  "Audio only — camera stays off on our side and yours",
  "Audio recorded, video live only (not recorded)",
  "Audio + video recorded",
] as const;

/** How long we keep the raw session recordings before deleting them. */
export const CALL_RETENTION_OPTIONS = [
  "Delete raw takes as soon as the track is delivered",
  "Keep raw takes 30 days after delivery, then delete",
  "Keep raw takes 90 days after delivery, then delete",
  "Keep raw takes until I ask for deletion",
] as const;

/** Plain-language retention facts shown before the artist proceeds. */
export const CALL_PRIVACY_NOTES = [
  "We only record what you pick above — nothing is captured before you join or after the call ends.",
  "Recordings are used to produce your track and nothing else unless you opt in to promo use below.",
  "Raw takes are stored on our studio's private storage and shared only with the producers on your track.",
  "Your finished master is kept for your order history; raw takes follow the retention choice above.",
  "You can ask us to delete your recordings at any time by messaging the studio desk on WhatsApp.",
] as const;

/** True when the brief asks for a live video-chat vocal session. */
export function needsVocalCall(b: TrackBrief): boolean {
  return b.vocals === VOCAL_OPTIONS[0];
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The call step is complete once a date and a window are chosen. */
/** The brief's video-chat room, created on first use. */
export function ensureCallRoom(b: TrackBrief): string {
  return b.callRoom || generateCallRoom();
}

export function callMeetingLink(b: TrackBrief): string {
  return b.callRoom ? meetingLinkForRoom(b.callRoom, callPhoneE164(b)) : "";
}

export function callReady(b: TrackBrief): boolean {
  if (!needsVocalCall(b)) return true;
  return (
    b.callDate.trim().length > 0 &&
    b.callWindow.trim().length > 0 &&
    phoneReady(b) &&
    b.callRecordConsent
  );
}

/** Dates must be today or later. */
export function callDateIsFuture(value: string): boolean {
  if (!value) return true;
  return value >= new Date().toISOString().slice(0, 10);
}

export const DELIVERABLE_OPTIONS = [
  "WAV master (24-bit)",
  "MP3 320kbps",
  "Streaming-ready master (-14 LUFS)",
  "Club / DJ master",
] as const;

export const MUSICAL_KEYS = [
  "Let the producer choose",
  "C major", "C minor", "C# / Db minor", "D major", "D minor",
  "E major", "E minor", "F major", "F minor", "F# / Gb minor",
  "G major", "G minor", "A major", "A minor", "B major", "B minor",
] as const;

/** Comma / newline separated free text → clean list. */
export function splitLines(input: string): string[] {
  return input
    .split(/[\n,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function emptyBrief(): TrackBrief {
  return {
    workingTitle: "",
    genre: "",
    subGenres: [],
    mood: "",
    language: "English",
    references: [],
    tempoBpm: null,
    tempoFeel: "Mid tempo",
    key: "Let the producer choose",
    vocals: VOCAL_OPTIONS[0],
    callDate: "",
    callAltDate: "",
    callWindow: CALL_WINDOWS[1],
    callTimezone: browserTimezone(),
    callRoom: "",
    callPhoneCountry: "+1",
    callPhoneNumber: "",
    callRecordConsent: false,
    callCapture: CALL_CAPTURE_OPTIONS[0],
    callRetention: CALL_RETENTION_OPTIONS[1],
    callPromoConsent: false,
    callGuestsAllowed: false,
    deliverables: ["WAV master (24-bit)", "MP3 320kbps"],
    stems: false,
    radioEdit: false,
    instrumental: false,
    notes: "",
  };
}

/** Step 1 (direction) is complete when we know what kind of song this is. */
export function directionReady(b: TrackBrief): boolean {
  return b.workingTitle.trim().length > 0 && b.genre.trim().length > 0;
}

/** Step 3 needs at least one file format to hand back. */
export function deliverablesReady(b: TrackBrief): boolean {
  return b.deliverables.length > 0;
}

export function briefIsReady(b: TrackBrief): boolean {
  return directionReady(b) && deliverablesReady(b) && callReady(b);
}

export function isValidBpm(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 40 && value <= 220);
}

/** Human-readable version stored with the order so the studio can work from it. */
export function briefToNotes(b: TrackBrief): string {
  const lines = [
    "Track brief",
    b.workingTitle.trim() ? `Working title: ${b.workingTitle.trim()}` : null,
    b.genre.trim() ? `Genre: ${b.genre.trim()}` : null,
    b.subGenres.length ? `Sub-genres: ${b.subGenres.join(", ")}` : null,
    b.mood.trim() ? `Mood: ${b.mood.trim()}` : null,
    b.language.trim() ? `Language: ${b.language.trim()}` : null,
    b.references.length ? `References:\n${b.references.map((r) => `  - ${r}`).join("\n")}` : null,
    b.tempoBpm ? `Tempo: ${b.tempoBpm} BPM (${b.tempoFeel})` : `Tempo feel: ${b.tempoFeel}`,
    b.key.trim() ? `Key: ${b.key.trim()}` : null,
    b.vocals.trim() ? `Vocals: ${b.vocals.trim()}` : null,
    needsVocalCall(b) && b.callDate
      ? `Vocal call: ${b.callDate} · ${b.callWindow} (${b.callTimezone})${b.callAltDate ? ` · backup date ${b.callAltDate}` : ""}`
      : null,
    needsVocalCall(b)
      ? `Artist WhatsApp: ${callPhoneE164(b) || "not provided"}`
      : null,
    needsVocalCall(b)
      ? `Recording consent: ${b.callRecordConsent ? "given" : "not given"} · Capture: ${b.callCapture} · Retention: ${b.callRetention} · Promo use: ${b.callPromoConsent ? "allowed" : "not allowed"} · Extra team on call: ${b.callGuestsAllowed ? "allowed" : "producer only"}`
      : null,
    needsVocalCall(b) && b.callRoom
      ? `WhatsApp video call: ${meetingLinkForRoom(b.callRoom, callPhoneE164(b))}\nCall instructions:\n${CALL_INSTRUCTIONS.map((l) => `  - ${l}`).join("\n")}`
      : null,
    b.deliverables.length ? `Deliverables: ${b.deliverables.join(", ")}` : null,
    [
      b.stems ? "stems" : null,
      b.radioEdit ? "radio edit" : null,
      b.instrumental ? "instrumental version" : null,
    ].filter(Boolean).length
      ? `Extras: ${[b.stems ? "stems" : null, b.radioEdit ? "radio edit" : null, b.instrumental ? "instrumental version" : null].filter(Boolean).join(", ")}`
      : null,
    b.notes.trim() ? `Notes: ${b.notes.trim()}` : null,
  ].filter(Boolean);

  return lines.join("\n").slice(0, 3800);
}

const storageKey = (slug: string) => `har.track-brief.${slug}`;

export function loadBrief(slug: string): TrackBrief | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<TrackBrief>;
    if (!parsed || typeof parsed !== "object") return null;
    const base = emptyBrief();
    return {
      ...base,
      ...parsed,
      subGenres: Array.isArray(parsed.subGenres) ? parsed.subGenres : base.subGenres,
      references: Array.isArray(parsed.references) ? parsed.references : base.references,
      deliverables: Array.isArray(parsed.deliverables) ? parsed.deliverables : base.deliverables,
    };
  } catch {
    return null;
  }
}

export function saveBrief(slug: string, brief: TrackBrief): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(slug), JSON.stringify(brief));
  } catch {
    /* storage unavailable — the brief still lives in component state */
  }
}
