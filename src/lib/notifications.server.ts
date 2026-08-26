/**
 * Server-only helper that records an in-app notification and, when the
 * mail gateway is configured, mirrors it to the artist's email address.
 *
 * Nothing here throws: a notification is never allowed to break the action
 * that triggered it (a token credit, a refund, a failed generation).
 */
import { sendSessionEmail } from "./session-mailer.server";

export type NotificationKind = "token_credit" | "token_refund" | "generation_failed";

export type NotifyInput = {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  reference?: string | null;
  /** Skip the email mirror (in-app only). */
  emailless?: boolean;
};

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Looks up the account email for a user id through the Auth admin API. */
async function resolveEmail(userId: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    return data?.user?.email ?? null;
  } catch (err) {
    console.error("Notification email lookup failed", err);
    return null;
  }
}

export async function notifyUser(input: NotifyInput): Promise<{ emailed: boolean }> {
  let emailed = false;

  if (!input.emailless) {
    const email = await resolveEmail(input.userId);
    if (email) {
      const html = `<div style="font-family:Arial,sans-serif;color:#111">
  <h2 style="margin:0 0 12px">${escapeHtml(input.title)}</h2>
  <p style="margin:0 0 12px;line-height:1.5">${escapeHtml(input.body)}</p>
  <p style="margin:0;color:#666;font-size:12px">Hybrid AI Records — Hybrid Engine 1.0 Alpha</p>
</div>`;
      const result = await sendSessionEmail({
        to: [email],
        subject: input.title,
        html,
        text: `${input.title}\n\n${input.body}\n\nHybrid AI Records`,
      });
      emailed = result.ok;
    }
  }

  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_notifications").insert({
      user_id: input.userId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      body: input.body.slice(0, 1000),
      reference: input.reference ?? null,
      emailed,
    });
  } catch (err) {
    console.error("Failed to record in-app notification", err);
  }

  return { emailed };
}
