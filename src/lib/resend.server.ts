/**
 * Direct Resend SDK sends for transactional receipts.
 *
 * Mail is never allowed to fail the action that triggered it. Missing
 * `RESEND_API_KEY` is a quiet no-op so local boxes stay usable.
 */
import { Resend } from "resend";
import { TokenPurchaseEmail, type TokenPurchaseEmailProps } from "@/emails/TokenPurchaseEmail";
import { defaultSiteOrigin } from "@/lib/site-origin.server";
import { SESSION_EMAIL_FROM, SESSION_EMAIL_REPLY_TO } from "@/lib/session-email-identity";

export type TokenEmailKind = TokenPurchaseEmailProps["tokenKind"];

function fromAddress(): string {
  const configured = process.env.RESEND_FROM?.trim();
  return configured || SESSION_EMAIL_FROM;
}

function studioUrlFor(kind: TokenEmailKind): string {
  const origin = defaultSiteOrigin();
  if (kind === "v") return `${origin}/v-tokens`;
  if (kind === "artist") return `${origin}/`;
  return `${origin}/studio`;
}

async function resolveAccountEmail(userId: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = data?.user?.email?.trim();
    return email && email.includes("@") ? email : null;
  } catch (err) {
    console.error("Token receipt email lookup failed", err);
    return null;
  }
}

export async function sendTokenPurchaseEmail(input: {
  to: string;
  amount: number;
  balance: number;
  tokenKind: TokenEmailKind;
}): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.error("RESEND_API_KEY is not configured");
    return { ok: false, reason: "not_configured" };
  }

  const to = input.to.trim();
  if (!to.includes("@")) return { ok: false, reason: "no_recipient" };

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromAddress(),
      to,
      replyTo: SESSION_EMAIL_REPLY_TO,
      subject: "Your Tokens Have Been Credited!",
      react: TokenPurchaseEmail({
        amount: input.amount,
        balance: input.balance,
        tokenKind: input.tokenKind,
        studioUrl: studioUrlFor(input.tokenKind),
      }),
    });
    if (error) {
      console.error("Resend token email failed:", error);
      return { ok: false, reason: error.message ?? "send_failed" };
    }
    return { ok: true };
  } catch (err) {
    console.error("Resend token email threw:", err);
    return { ok: false, reason: "send_failed" };
  }
}

/** Looks up the account email and sends the purchase receipt. Never throws. */
export async function sendTokenPurchaseReceipt(input: {
  userId: string;
  amount: number;
  balance: number;
  tokenKind: TokenEmailKind;
  fallbackEmail?: string | null;
}): Promise<void> {
  try {
    const to = input.fallbackEmail?.includes("@")
      ? input.fallbackEmail
      : await resolveAccountEmail(input.userId);
    if (!to) return;
    await sendTokenPurchaseEmail({
      to,
      amount: input.amount,
      balance: input.balance,
      tokenKind: input.tokenKind,
    });
  } catch (err) {
    console.error("Token purchase receipt send failed", err);
  }
}
