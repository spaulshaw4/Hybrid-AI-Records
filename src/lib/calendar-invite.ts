/**
 * Calendar export helpers for booked vocal sessions.
 *
 * Slots are captured as a plain date + time in the artist's IANA timezone, so
 * every export first resolves that wall-clock time to a real UTC instant —
 * otherwise the event lands in the wrong hour for anyone outside that zone.
 */

import { resolveTimeZone } from "./timezone";

export type CalendarSlot = { date: string; time: string };

export const DEFAULT_SESSION_MINUTES = 60;

/** Offset (in minutes) of `utcDate` in `timeZone`, e.g. -240 for New York in summer. */
function zoneOffsetMinutes(utcDate: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(utcDate).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const asUTC = Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]),
    Number(parts["hour"]) === 24 ? 0 : Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  );
  return (asUTC - utcDate.getTime()) / 60000;
}

/** Resolve `YYYY-MM-DD` + `HH:MM` in `timeZone` to the matching UTC instant. */
export function slotToUtcDate(slot: CalendarSlot, timeZone: string): Date | null {
  // An unusable zone id would otherwise throw inside Intl and shift the event.
  const zone = resolveTimeZone(timeZone).timeZone;
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(slot.date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(slot.time.trim());
  if (!dateMatch || !timeMatch) return null;

  const naive = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    Number(timeMatch[1]),
    Number(timeMatch[2]),
  );
  if (Number.isNaN(naive)) return null;

  let guess = new Date(naive);
  // Two passes settle DST boundaries: the first offset may belong to the wrong side.
  for (let i = 0; i < 2; i += 1) {
    let offset: number;
    try {
      offset = zoneOffsetMinutes(guess, zone);
    } catch {
      return new Date(naive);
    }
    guess = new Date(naive - offset * 60000);
  }
  return guess;
}

function stampUtc(date: Date): string {
  return `${date.toISOString().replace(/[-:]/g, "").split(".")[0]}Z`;
}

export interface CalendarEventInput {
  artist: string;
  slot: CalendarSlot;
  timezone: string;
  packageLabel?: string | null;
  meetingLink?: string | null;
  durationMinutes?: number;
  uid?: string;
}

function eventWindow(input: CalendarEventInput) {
  const start = slotToUtcDate(input.slot, input.timezone);
  if (!start) return null;
  const minutes = input.durationMinutes ?? DEFAULT_SESSION_MINUTES;
  return { start, end: new Date(start.getTime() + minutes * 60000) };
}

export function eventTitle(input: CalendarEventInput): string {
  return `Vocal session — Hybrid AI Records${input.packageLabel ? ` · ${input.packageLabel}` : ""}`;
}

function eventDescription(input: CalendarEventInput): string {
  return [
    `Live vocal recording session for ${input.artist}.`,
    input.packageLabel ? `Package: ${input.packageLabel}` : null,
    input.meetingLink ? `Video chat: ${input.meetingLink}` : null,
    "Join a few minutes early to check mic levels.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Escape per RFC 5545 text rules. */
function ics(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Full .ics document for one confirmed session (Apple Calendar, Outlook, etc.). */
export function buildIcsFile(input: CalendarEventInput): string | null {
  const window = eventWindow(input);
  if (!window) return null;
  const uid = input.uid ?? `${stampUtc(window.start)}-hybrid-ai-records`;

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hybrid AI Records//Vocal Sessions//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${ics(uid)}`,
    `DTSTAMP:${stampUtc(new Date())}`,
    `DTSTART:${stampUtc(window.start)}`,
    `DTEND:${stampUtc(window.end)}`,
    `SUMMARY:${ics(eventTitle(input))}`,
    `DESCRIPTION:${ics(eventDescription(input))}`,
    input.meetingLink ? `LOCATION:${ics(input.meetingLink)}` : "LOCATION:Video chat",
    input.meetingLink ? `URL:${ics(input.meetingLink)}` : null,
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "ACTION:DISPLAY",
    "DESCRIPTION:Vocal session starts in 15 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter((line): line is string => line !== null)
    .join("\r\n");
}

/** One-click "add to Google Calendar" URL for the same event. */
export function buildGoogleCalendarUrl(input: CalendarEventInput): string | null {
  const window = eventWindow(input);
  if (!window) return null;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: eventTitle(input),
    dates: `${stampUtc(window.start)}/${stampUtc(window.end)}`,
    details: eventDescription(input),
    location: input.meetingLink || "Video chat",
    ctz: resolveTimeZone(input.timezone).timeZone,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Suggested download filename for the .ics attachment. */
export function icsFileName(input: CalendarEventInput): string {
  const safeArtist = input.artist.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `vocal-session-${safeArtist || "hybrid"}-${input.slot.date}.ics`;
}

/** Base64 (UTF-8 safe) encoder that works in both the browser and the Worker runtime. */
function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export interface IcsAttachment {
  filename: string;
  /** Base64-encoded .ics payload, ready for the mail provider. */
  content: string;
  contentType: string;
}

/**
 * Build the .ics file for a confirmed slot as a mail attachment.
 * Returns null when the slot cannot be resolved to a real instant.
 */
export function buildIcsAttachment(input: CalendarEventInput): IcsAttachment | null {
  const ics = buildIcsFile(input);
  if (!ics) return null;
  return {
    filename: icsFileName(input),
    content: toBase64(ics),
    contentType: "text/calendar; charset=utf-8; method=PUBLISH",
  };
}
