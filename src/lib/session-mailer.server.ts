/**
 * Server-only mailer for vocal-session notifications.
 *
 * Sends through the Resend connector gateway (the same path the application
 * emails already use). A mail failure is never fatal: the session row is
 * always written first, so we log and report instead of throwing.
 */
const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";

/** Staff inbox that mirrors every artist-facing session notification. */
export const STAFF_NOTIFY_TO = "Hybrid.AI.Records@proton.me";

import { SESSION_EMAIL_FROM } from "./session-email-identity";

const FROM = SESSION_EMAIL_FROM;


export type MailResult = { ok: boolean; reason?: string };

/** File attached to a notification (base64 content, e.g. a calendar invite). */
export type MailAttachment = { filename: string; content: string; contentType?: string };

/** Kinds of session notification we record in the on-page delivery log. */
export type SessionEmailKind =
  | "received"
  | "reschedule_requested"
  | "confirmed"
  | "rescheduled"
  | "declined"
  | "cancelled"
  | "resend";



/**
 * Writes one row to the staff-visible delivery log. Never throws: a logging
 * failure must not break the notification itself.
 */
async function logSessionEmail(entry: {
  requestId: string;
  kind: SessionEmailKind;
  recipient: string;
  subject: string;
  result: MailResult;
  slot?: { date: string; time: string } | null;
}) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("session_email_log").insert({
      request_id: entry.requestId,
      kind: entry.kind,
      recipient: entry.recipient,
      subject: entry.subject.slice(0, 300),
      outcome: entry.result.ok ? "sent" : "failed",
      reason: entry.result.ok ? null : (entry.result.reason ?? "unknown"),
      slot: entry.slot ?? null,
    });
  } catch (err) {
    console.error("Failed to record session email log entry", err);
  }
}

export async function sendSessionEmail(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
  /** When present, the attempt is recorded in the staff delivery log. */
  log?: {
    requestId: string;
    kind: SessionEmailKind;
    slot?: { date: string; time: string } | null;
  };
}): Promise<MailResult> {
  const result = await deliver(input);
  if (input.log) {
    await logSessionEmail({
      requestId: input.log.requestId,
      kind: input.log.kind,
      recipient: input.to[0] ?? "unknown",
      subject: input.subject,
      result,
      slot: input.log.slot ?? null,
    });
  }
  return result;
}

async function deliver(input: {
  to: string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  attachments?: MailAttachment[];
}): Promise<MailResult> {

  const lovableKey = process.env['LOVABLE_API_KEY'];
  const resendKey = process.env['RESEND_API_KEY'];
  if (!lovableKey || !resendKey) {
    console.error("Session mailer is not configured (missing gateway credentials)");
    return { ok: false, reason: "not_configured" };
  }

  const recipients = input.to.filter((address) => address.includes("@"));
  if (recipients.length === 0) return { ok: false, reason: "no_recipient" };

  const response = await fetch(`${GATEWAY_URL}/emails`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lovableKey}`,
      "X-Connection-Api-Key": resendKey,
    },
    body: JSON.stringify({
      from: FROM,
      to: recipients,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.attachments?.length
        ? {
            attachments: input.attachments.map((file) => ({
              filename: file.filename,
              content: file.content,
              ...(file.contentType ? { content_type: file.contentType } : {}),
            })),
          }
        : {}),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error(`Session email send failed [${response.status}]: ${body}`);
    return { ok: false, reason: `send_failed_${response.status}` };
  }

  return { ok: true };
}
