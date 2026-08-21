import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildIcsAttachment } from "./calendar-invite";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const slot = z.object({
  date: z.string().trim().min(1).max(20),
  time: z.string().trim().min(1).max(10),
});

const receivedInput = z.object({
  requestId: z.string().uuid(),
});

const statusInput = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["confirmed", "rescheduled", "declined", "cancelled"]),
  slot: slot.optional().nullable(),
  message: z.string().trim().max(1000).optional().nullable(),
});

/**
 * Artist-facing acknowledgement for a freshly submitted (or rescheduled)
 * session request. Public on purpose — guests book without an account — so it
 * takes only a row id and reads every value it emails from the database.
 */
export const notifyVocalSessionReceived = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => receivedInput.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildSlotRequestConfirmationEmail } = await import("./vocal-session-email");
    const { sendSessionEmail, STAFF_NOTIFY_TO } = await import("./session-mailer.server");

    const { data: row, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .select(
        "id, artist, email, timezone, package_label, notes, slots, created_at, status, reschedule_round, confirmed_slot, meeting_link",
      )
      .eq("id", data.requestId)
      .single();
    if (error || !row) return { ok: false, reason: "not_found" as const };

    const slots = Array.isArray(row.slots)
      ? (row.slots as { date?: string; time?: string }[])
          .filter((s) => s?.date && s?.time)
          .map((s) => ({ date: String(s.date), time: String(s.time) }))
      : [];
    if (slots.length === 0) return { ok: false, reason: "no_slots" as const };

    const held = (row.confirmed_slot ?? null) as { date?: string; time?: string } | null;
    const heldSlot =
      held?.date && held?.time ? { date: String(held.date), time: String(held.time) } : null;

    const email = buildSlotRequestConfirmationEmail({
      artist: row.artist,
      timezone: row.timezone,
      packageLabel: row.package_label,
      slots,
      notes: row.notes,
      rescheduleRound:
        Number(row.reschedule_round ?? 0) ||
        (/Reschedule request/i.test(row.notes ?? "") ? 1 : 0),
      currentStatus: row.status,
      confirmedSlot: heldSlot,
      meetingLink: row.meeting_link,
    });

    const result = await sendSessionEmail({
      to: [row.email, STAFF_NOTIFY_TO],
      replyTo: row.email,
      subject: email.subject,
      html: email.html,
      text: email.text,
      log: {
        requestId: row.id,
        kind: Number(row.reschedule_round ?? 0) > 0 ? "reschedule_requested" : "received",
      },
    });
    return result;
  });

/** Seconds an artist must wait between "resend my confirmation" presses. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Artist-facing "I never got the email" resend. Public by design (guests book
 * without an account) but deliberately narrow: it only ever re-sends the
 * current confirmation to the address already stored on the row, and is rate
 * limited so the button cannot be used to mail-bomb an address.
 */
export const resendVocalSessionConfirmation = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => receivedInput.parse(data))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildSlotRequestConfirmationEmail, buildSessionStatusEmail } = await import(
      "./vocal-session-email"
    );
    const { sendSessionEmail } = await import("./session-mailer.server");

    const { data: row, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .select(
        "id, artist, email, timezone, package_label, notes, slots, status, reschedule_round, confirmed_slot, meeting_link",
      )
      .eq("id", data.requestId)
      .single();
    if (error || !row) return { ok: false, reason: "not_found" as const };

    // Cooldown: look at the most recent resend for this request.
    const { data: last } = await supabaseAdmin
      .from("session_email_log")
      .select("created_at")
      .eq("request_id", row.id)
      .eq("kind", "resend")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.created_at) {
      const elapsed = (Date.now() - new Date(last.created_at).getTime()) / 1000;
      if (elapsed < RESEND_COOLDOWN_SECONDS) {
        return {
          ok: false,
          reason: "cooldown" as const,
          retryInSeconds: Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed),
        };
      }
    }

    const confirmed = (row.confirmed_slot ?? null) as { date?: string; time?: string } | null;
    const confirmedSlot =
      confirmed?.date && confirmed?.time
        ? { date: String(confirmed.date), time: String(confirmed.time) }
        : null;

    const slots = Array.isArray(row.slots)
      ? (row.slots as { date?: string; time?: string }[])
          .filter((s) => s?.date && s?.time)
          .map((s) => ({ date: String(s.date), time: String(s.time) }))
      : [];

    const isConfirmed =
      (row.status === "confirmed" || row.status === "rescheduled") && Boolean(confirmedSlot);

    const email = isConfirmed
      ? buildSessionStatusEmail({
          artist: row.artist,
          status: row.status as "confirmed" | "rescheduled",
          timezone: row.timezone,
          packageLabel: row.package_label,
          slot: confirmedSlot,
          meetingLink: row.meeting_link,
          message: null,
        })
      : buildSlotRequestConfirmationEmail({
          artist: row.artist,
          timezone: row.timezone,
          packageLabel: row.package_label,
          slots,
          notes: row.notes,
          rescheduleRound: Number(row.reschedule_round ?? 0),
          currentStatus: row.status,
          confirmedSlot,
          meetingLink: row.meeting_link,
        });

    const invite =
      isConfirmed && confirmedSlot
        ? buildIcsAttachment({
            artist: row.artist,
            slot: confirmedSlot,
            timezone: row.timezone,
            packageLabel: row.package_label,
            meetingLink: row.meeting_link,
            uid: row.id,
          })
        : null;

    const result = await sendSessionEmail({
      to: [row.email],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(invite ? { attachments: [invite] } : {}),
      log: { requestId: row.id, kind: "resend", slot: confirmedSlot },
    });

    return { ...result, recipient: row.email, cooldownSeconds: RESEND_COOLDOWN_SECONDS };
  });


/**
 * Staff-only status update. Every state change on a session (confirmed,
 * rescheduled, declined, cancelled) emails the artist with the current slot,
 * their timezone and — where relevant — the video-chat room.
 */
export const notifyVocalSessionStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => statusInput.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildSessionStatusEmail } = await import("./vocal-session-email");
    const { sendSessionEmail, STAFF_NOTIFY_TO } = await import("./session-mailer.server");

    const nextSlot = data.slot ?? null;
    const clears = data.status === "declined" || data.status === "cancelled";
    const patch = {
      status: data.status,
      ...(nextSlot && !clears
        ? { confirmed_slot: nextSlot, confirmed_at: new Date().toISOString() }
        : {}),
      ...(clears ? { confirmed_slot: null, confirmed_at: null } : {}),
    };


    const { data: row, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .update(patch)
      .eq("id", data.requestId)
      .select("id, artist, email, timezone, package_label, meeting_link, confirmed_slot, status")
      .single();
    if (error || !row) throw new Error(error?.message ?? "Session request not found");

    const confirmed = (row.confirmed_slot ?? null) as { date?: string; time?: string } | null;
    const slotForEmail =
      nextSlot ??
      (confirmed?.date && confirmed?.time
        ? { date: String(confirmed.date), time: String(confirmed.time) }
        : null);

    const email = buildSessionStatusEmail({
      artist: row.artist,
      status: data.status,
      timezone: row.timezone,
      packageLabel: row.package_label,
      slot: slotForEmail,
      meetingLink: row.meeting_link,
      message: data.message ?? null,
    });

    // Only a live confirmed/rescheduled booking gets a calendar invite attached.
    const invite =
      (data.status === "confirmed" || data.status === "rescheduled") && slotForEmail
        ? buildIcsAttachment({
            artist: row.artist,
            slot: slotForEmail,
            timezone: row.timezone,
            packageLabel: row.package_label,
            meetingLink: row.meeting_link,
            uid: row.id,
          })
        : null;

    const mail = await sendSessionEmail({
      to: [row.email, STAFF_NOTIFY_TO],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(invite ? { attachments: [invite] } : {}),
      log: { requestId: row.id, kind: data.status, slot: slotForEmail },
    });

    return { requestId: row.id, status: row.status, mail, meetingLink: row.meeting_link };
  });
