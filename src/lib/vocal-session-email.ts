import { buildGoogleCalendarUrl } from "./calendar-invite";
import { timeZoneLabel } from "./timezone";

export type SessionSlot = { date: string; time: string };

/**
 * Plain-text staff confirmation body for an approved vocal session.
 * The video-chat room is generated automatically when the artist submits, so
 * the confirmation always carries a working link.
 */
export function buildStaffConfirmationEmail(input: {
  artist: string;
  timezone: string;
  packageLabel: string | null;
  slot: SessionSlot;
  meetingLink: string;
}) {
  const subject = `Vocal session confirmed — ${input.artist} · ${input.slot.date} ${input.slot.time}`;
  const googleUrl = buildGoogleCalendarUrl({
    artist: input.artist,
    slot: input.slot,
    timezone: input.timezone,
    packageLabel: input.packageLabel,
    meetingLink: input.meetingLink,
  });

  const lines = [
    `Vocal session confirmed for ${input.artist}.`,
    "",
    `Date: ${input.slot.date}`,
    `Time: ${input.slot.time} (${timeZoneLabel(input.timezone)})`,
    input.packageLabel ? `Package: ${input.packageLabel}` : null,
    "",
    "Video chat link:",
    input.meetingLink || "(link unavailable — check the session request record)",
    "",
    ...(googleUrl ? ["", "Add to calendar (Google):", googleUrl] : []),
    "",
    "Join a few minutes early to check mic levels. The link stays valid for the session and any reschedule.",
    "",
    "— Hybrid AI Records",
  ].filter((l) => l !== null);

  return { subject, text: lines.join("\n") };
}

/** Escape user-supplied values before they land in the HTML body. */
function esc(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** "2026-08-12" + "18:30" -> "Wed, Aug 12, 2026 · 6:30 PM" (falls back to raw). */
function prettySlot(slot: SessionSlot) {
  const [y, m, d] = slot.date.split("-").map(Number);
  const [hh, mm] = slot.time.split(":").map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) {
    return `${slot.date} ${slot.time}`.trim();
  }
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
  return `${day} · ${time}`;
}

/**
 * Artist-facing confirmation for a submitted (not yet approved) vocal session
 * request. Echoes back every slot they picked and the timezone they chose so
 * they can spot a mistake before we lock a room in.
 */
export function buildSlotRequestConfirmationEmail(input: {
  artist: string;
  timezone: string;
  packageLabel?: string | null;
  slots: SessionSlot[];
  notes?: string | null;
  rescheduleRound?: number;
  /** Where the booking stands right now (requested, confirmed, …). */
  currentStatus?: string | null;
  /** A slot already confirmed before this reschedule was sent, if any. */
  confirmedSlot?: SessionSlot | null;
  meetingLink?: string | null;
}) {
  const round = input.rescheduleRound ?? 0;
  const isReschedule = round > 0;
  const subject = isReschedule
    ? `Reschedule request #${round} received — ${input.artist}`
    : `Vocal session request received — ${input.artist}`;

  const rows = input.slots.map((s, i) => ({
    label: `Option ${i + 1}`,
    value: `${prettySlot(s)} (${timeZoneLabel(input.timezone)})`,
  }));

  const statusLabel = (() => {
    const s = (input.currentStatus ?? "requested").toLowerCase();
    if (input.confirmedSlot?.date && input.confirmedSlot?.time) {
      return isReschedule
        ? `Confirmed for ${prettySlot(input.confirmedSlot)} (${timeZoneLabel(input.timezone)}) — held until we approve one of your new times`
        : `Confirmed for ${prettySlot(input.confirmedSlot)} (${timeZoneLabel(input.timezone)})`;
    }
    if (s === "requested") return isReschedule ? "New times under review" : "Awaiting confirmation";
    return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  })();


  const text = [
    `Hi ${input.artist},`,
    "",
    isReschedule
      ? "We received your reschedule request. Here are the new times you sent us:"
      : "We received your vocal session request. Here are the times you sent us:",
    "",
    ...rows.map((r) => `${r.label}: ${r.value}`),
    "",
    `Timezone: ${timeZoneLabel(input.timezone)}`,
    `Session status: ${statusLabel}`,
    isReschedule ? `Reschedule round: #${round} (your original booking details are kept)` : null,
    input.meetingLink ? `Video-chat room: ${input.meetingLink}` : null,
    input.packageLabel ? `Package: ${input.packageLabel}` : null,
    input.notes ? `Your notes: ${input.notes}` : null,

    "",
    "Our engineering desk reviews requests Mon–Sat, 10:00–20:00 ET. Once a slot is approved you'll get a second email with your private video-chat link and a calendar invite.",
    "",
    "If any of these times are wrong, just reply to this email.",
    "",
    "— Hybrid AI Records",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const slotHtml = rows
    .map(
      (r) => `
        <tr>
          <td style="padding:10px 14px;border-bottom:1px solid #ececec;font:600 13px Arial,sans-serif;color:#8a0f1f;white-space:nowrap;">${esc(r.label)}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">${esc(r.value)}</td>
        </tr>`,
    )
    .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(
    isReschedule ? "Your new proposed times" : "We got your proposed session times",
  )} — ${esc(timeZoneLabel(input.timezone))}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid #e6e6e6;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#111111;padding:20px 24px;">
          <div style="font:700 16px Arial,sans-serif;color:#ffffff;letter-spacing:0.04em;">HYBRID <span style="color:#c81e2d;">AI</span> RECORDS</div>
          <div style="font:400 12px Arial,sans-serif;color:#9a9a9a;margin-top:4px;">Vocal session booking</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <h1 style="margin:0 0 12px;font:700 20px Arial,sans-serif;color:#111111;">${esc(
            isReschedule ? "Reschedule request received" : "Session request received",
          )}</h1>
          <p style="margin:0 0 18px;font:400 14px/1.6 Arial,sans-serif;color:#3a3a3a;">Hi ${esc(
            input.artist,
          )}, thanks — we've logged the times below. Nothing is locked in yet; we'll confirm one slot by email.</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececec;border-radius:8px;">
            ${slotHtml}
            <tr>
              <td style="padding:10px 14px;font:600 13px Arial,sans-serif;color:#1a3a8a;white-space:nowrap;">Timezone</td>
              <td style="padding:10px 14px;font:400 14px Arial,sans-serif;color:#1a1a1a;">${esc(timeZoneLabel(input.timezone))}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#1a3a8a;white-space:nowrap;">Session status</td>
              <td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">${esc(statusLabel)}</td>
            </tr>
            ${
              isReschedule
                ? `<tr><td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#8a0f1f;white-space:nowrap;">Reschedule</td><td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">Round #${round} — your original booking details are kept</td></tr>`
                : ""
            }
            ${
              input.meetingLink
                ? `<tr><td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#1a3a8a;white-space:nowrap;">Video-chat room</td><td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;"><a href="${esc(
                    input.meetingLink,
                  )}" style="color:#8a0f1f;">${esc(input.meetingLink)}</a></td></tr>`
                : ""
            }

            ${
              input.packageLabel
                ? `<tr><td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#1a3a8a;">Package</td><td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">${esc(
                    input.packageLabel,
                  )}</td></tr>`
                : ""
            }
            ${
              input.notes
                ? `<tr><td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#1a3a8a;vertical-align:top;">Your notes</td><td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">${esc(
                    input.notes,
                  )}</td></tr>`
                : ""
            }
          </table>
          <p style="margin:18px 0 0;font:400 13px/1.6 Arial,sans-serif;color:#5a5a5a;">Our engineering desk reviews requests Mon–Sat, 10:00–20:00 ET. When a slot is approved you'll get your private video-chat link and a calendar invite.</p>
          <p style="margin:14px 0 0;font:400 13px/1.6 Arial,sans-serif;color:#5a5a5a;">Something wrong with these times? Just reply to this email.</p>
        </td></tr>
        <tr><td style="background-color:#fafafa;padding:16px 24px;border-top:1px solid #ececec;">
          <div style="font:400 12px Arial,sans-serif;color:#8a8a8a;">Hybrid AI Records LLC · SBA Veteran-Certified</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}

export type SessionStatus = "confirmed" | "rescheduled" | "declined" | "cancelled";

const STATUS_COPY: Record<
  SessionStatus,
  { badge: string; heading: string; lead: string; accent: string }
> = {
  confirmed: {
    badge: "Confirmed",
    heading: "Your vocal session is confirmed",
    lead: "We locked in one of your proposed times. Details and your private video-chat room are below.",
    accent: "#0f7a3d",
  },
  rescheduled: {
    badge: "Rescheduled",
    heading: "Your vocal session moved",
    lead: "We had to shift your session. The new time is below — reply if it doesn't work and we'll pick another slot.",
    accent: "#1a3a8a",
  },
  declined: {
    badge: "Times unavailable",
    heading: "None of those times worked",
    lead: "Our desk couldn't take any of the slots you proposed. Send a few new times and we'll get you booked.",
    accent: "#8a0f1f",
  },
  cancelled: {
    badge: "Cancelled",
    heading: "Your vocal session was cancelled",
    lead: "This session is no longer on the calendar. Propose new times whenever you're ready.",
    accent: "#8a0f1f",
  },
};

/**
 * Artist-facing status update sent every time a scheduled session changes
 * state. Confirmed/rescheduled updates carry the slot, timezone and room link.
 */
export function buildSessionStatusEmail(input: {
  artist: string;
  status: SessionStatus;
  timezone: string;
  packageLabel?: string | null;
  slot?: SessionSlot | null;
  meetingLink?: string | null;
  message?: string | null;
}) {
  const copy = STATUS_COPY[input.status];
  const slotLine = input.slot ? `${prettySlot(input.slot)} (${timeZoneLabel(input.timezone)})` : null;
  const showLink =
    (input.status === "confirmed" || input.status === "rescheduled") && !!input.meetingLink;

  const subject = `Vocal session ${copy.badge.toLowerCase()} — ${input.artist}${
    slotLine ? ` · ${input.slot!.date} ${input.slot!.time}` : ""
  }`;

  const text = [
    `Hi ${input.artist},`,
    "",
    copy.lead,
    "",
    slotLine ? `When: ${slotLine}` : null,
    input.packageLabel ? `Package: ${input.packageLabel}` : null,
    showLink ? `Video chat: ${input.meetingLink}` : null,
    input.message ? `\nFrom our team: ${input.message}` : null,
    "",
    "— Hybrid AI Records",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const row = (label: string, value: string) => `
    <tr>
      <td style="padding:10px 14px;border-top:1px solid #ececec;font:600 13px Arial,sans-serif;color:#1a3a8a;white-space:nowrap;">${esc(label)}</td>
      <td style="padding:10px 14px;border-top:1px solid #ececec;font:400 14px Arial,sans-serif;color:#1a1a1a;">${value}</td>
    </tr>`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#ffffff;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(copy.lead)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#ffffff;">
    <tr><td align="center" style="padding:28px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border:1px solid #e6e6e6;border-radius:12px;overflow:hidden;">
        <tr><td style="background-color:#111111;padding:20px 24px;">
          <div style="font:700 16px Arial,sans-serif;color:#ffffff;letter-spacing:0.04em;">HYBRID <span style="color:#c81e2d;">AI</span> RECORDS</div>
          <div style="font:400 12px Arial,sans-serif;color:#9a9a9a;margin-top:4px;">Vocal session update</div>
        </td></tr>
        <tr><td style="padding:24px;">
          <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${copy.accent};font:700 11px Arial,sans-serif;color:#ffffff;letter-spacing:0.08em;text-transform:uppercase;">${esc(copy.badge)}</span>
          <h1 style="margin:12px 0 10px;font:700 20px Arial,sans-serif;color:#111111;">${esc(copy.heading)}</h1>
          <p style="margin:0 0 18px;font:400 14px/1.6 Arial,sans-serif;color:#3a3a3a;">Hi ${esc(input.artist)}, ${esc(copy.lead)}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ececec;border-radius:8px;">
            ${slotLine ? row("When", esc(slotLine)) : ""}
            ${row("Timezone", esc(timeZoneLabel(input.timezone)))}
            ${input.packageLabel ? row("Package", esc(input.packageLabel)) : ""}
            ${
              showLink
                ? row(
                    "Video chat",
                    `<a href="${esc(input.meetingLink!)}" style="color:#c81e2d;">${esc(input.meetingLink!)}</a>`,
                  )
                : ""
            }
            ${input.message ? row("From our team", esc(input.message).replace(/\n/g, "<br/>")) : ""}
          </table>
          <p style="margin:18px 0 0;font:400 13px/1.6 Arial,sans-serif;color:#5a5a5a;">Reply to this email with any changes — we'll send another update if anything moves.</p>
        </td></tr>
        <tr><td style="background-color:#fafafa;padding:16px 24px;border-top:1px solid #ececec;">
          <div style="font:400 12px Arial,sans-serif;color:#8a8a8a;">Hybrid AI Records LLC · SBA Veteran-Certified</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
