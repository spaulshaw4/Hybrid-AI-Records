import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { buildIcsAttachment } from "./calendar-invite";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const retryInput = z.object({ emailId: z.string().uuid() });

/** Seconds staff must wait between retries of the same session's notification. */
export const RETRY_COOLDOWN_SECONDS = 90;
/** Max retry attempts allowed across the whole inbox inside the window. */
export const RETRY_WINDOW_MINUTES = 10;
export const RETRY_WINDOW_LIMIT = 10;

/**
 * Staff-only "retry delivery" for a failed notification. Re-sends the email
 * that the log row represents to the address already stored on that row, and
 * is rate limited two ways so a stuck provider cannot be hammered:
 *  - per session: one retry every RETRY_COOLDOWN_SECONDS
 *  - globally: RETRY_WINDOW_LIMIT retries per RETRY_WINDOW_MINUTES
 */
export const retryFailedSessionEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: unknown) => retryInput.parse(data))
  .handler(async ({ data, context }) => {
    const { data: roles } = await context.supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId)
      .in("role", ["admin", "staff"]);
    if (!roles || roles.length === 0) throw new Error("Forbidden");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { buildSlotRequestConfirmationEmail, buildSessionStatusEmail } = await import(
      "./vocal-session-email"
    );
    const { sendSessionEmail } = await import("./session-mailer.server");

    const { data: entry, error: entryError } = await supabaseAdmin
      .from("session_email_log")
      .select("id, request_id, kind, recipient, outcome, slot, created_at")
      .eq("id", data.emailId)
      .single();
    if (entryError || !entry) return { ok: false, reason: "not_found" as const };
    if (entry.outcome === "sent") return { ok: false, reason: "already_sent" as const };

    // Rate limit 1: per-session cooldown on retries.
    const { data: lastRetry } = await supabaseAdmin
      .from("session_email_log")
      .select("created_at")
      .eq("request_id", entry.request_id)
      .eq("kind", "resend")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastRetry?.created_at) {
      const elapsed = (Date.now() - new Date(lastRetry.created_at).getTime()) / 1000;
      if (elapsed < RETRY_COOLDOWN_SECONDS) {
        return {
          ok: false,
          reason: "cooldown" as const,
          retryInSeconds: Math.ceil(RETRY_COOLDOWN_SECONDS - elapsed),
        };
      }
    }

    // Rate limit 2: global retry burst guard.
    const windowStart = new Date(Date.now() - RETRY_WINDOW_MINUTES * 60_000).toISOString();
    const { count } = await supabaseAdmin
      .from("session_email_log")
      .select("id", { count: "exact", head: true })
      .eq("kind", "resend")
      .gte("created_at", windowStart);
    if ((count ?? 0) >= RETRY_WINDOW_LIMIT) {
      return {
        ok: false,
        reason: "rate_limited" as const,
        retryInSeconds: RETRY_WINDOW_MINUTES * 60,
      };
    }

    const { data: row, error } = await supabaseAdmin
      .from("vocal_session_requests")
      .select(
        "id, artist, email, timezone, package_label, notes, slots, status, reschedule_round, confirmed_slot, meeting_link",
      )
      .eq("id", entry.request_id)
      .single();
    if (error || !row) return { ok: false, reason: "not_found" as const };

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

    const statusKinds = ["confirmed", "rescheduled", "declined", "cancelled"] as const;
    const statusKind = statusKinds.find((k) => k === entry.kind) ?? null;

    const email = statusKind
      ? buildSessionStatusEmail({
          artist: row.artist,
          status: statusKind,
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

    const wantsInvite =
      (statusKind === "confirmed" || statusKind === "rescheduled") && Boolean(confirmedSlot);
    const invite =
      wantsInvite && confirmedSlot
        ? buildIcsAttachment({
            artist: row.artist,
            slot: confirmedSlot,
            timezone: row.timezone,
            packageLabel: row.package_label,
            meetingLink: row.meeting_link,
            uid: row.id,
          })
        : null;

    const recipient = entry.recipient || row.email;
    const result = await sendSessionEmail({
      to: [recipient],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(invite ? { attachments: [invite] } : {}),
      log: { requestId: row.id, kind: "resend", slot: confirmedSlot },
    });

    return {
      ok: result.ok,
      ...(result.ok ? {} : { reason: result.reason ?? "send_failed" }),
      recipient,
      cooldownSeconds: RETRY_COOLDOWN_SECONDS,
    };
  });
