/**
 * Direct Resend SDK sends for transactional receipts.
 *
 * Mail is never allowed to fail the action that triggered it. Missing
 * `RESEND_API_KEY` is a quiet no-op so local boxes stay usable.
 */
import { Resend } from "resend";
import { TokenPurchaseEmail, type TokenPurchaseEmailProps } from "@/emails/TokenPurchaseEmail";
import { TrackCreationEmail } from "@/emails/TrackCreationEmail";
import { buildCertificateOfCreationPdf } from "@/lib/certificate-of-creation.server";
import { defaultSiteOrigin } from "@/lib/site-origin.server";
import { SESSION_EMAIL_FROM, SESSION_EMAIL_REPLY_TO } from "@/lib/session-email-identity";

export type TokenEmailKind = TokenPurchaseEmailProps["tokenKind"];

/** Track-completion mail that attaches the Certificate of Creation. */
const CLEARANCE_EMAIL_FROM = "Hybrid AI Records <clearance@hybrid-ai-records.com>";

function fromAddress(): string {
  const configured = process.env.RESEND_FROM?.trim() ?? "";
  const address = (configured.match(/<([^>]+)>/)?.[1] ?? configured).trim();
  const at = address.lastIndexOf("@");
  const local = at >= 0 ? address.slice(0, at) : "";
  const domain = at >= 0 ? address.slice(at + 1).toLowerCase() : "";
  if (local && !/\s/.test(local) && domain === "hybrid-ai-records.com") {
    return `Hybrid AI Records <${local}@hybrid-ai-records.com>`;
  }
  return SESSION_EMAIL_FROM;
}

function studioUrlFor(kind: TokenEmailKind): string {
  const origin = defaultSiteOrigin();
  if (kind === "v") return `${origin}/v-tokens`;
  if (kind === "artist") return `${origin}/`;
  return `${origin}/studio`;
}

function formatEmailDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
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

async function resolveCreatorName(userId: string, fallbackEmail?: string | null): Promise<string> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: profile } = await supabaseAdmin
      .from("profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    const display = profile?.display_name?.trim();
    if (display) return display;

    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    const meta = data?.user?.user_metadata as Record<string, unknown> | undefined;
    const fromMeta =
      (typeof meta?.display_name === "string" && meta.display_name.trim()) ||
      (typeof meta?.full_name === "string" && meta.full_name.trim()) ||
      (typeof meta?.name === "string" && meta.name.trim()) ||
      "";
    if (fromMeta) return fromMeta;

    const email = data?.user?.email?.trim() || fallbackEmail?.trim() || "";
    if (email.includes("@")) return email.split("@")[0] || "Hybrid AI Artist";
  } catch (err) {
    console.warn("[track completion email] creator name lookup failed", err);
  }
  return "Hybrid AI Artist";
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

export async function sendTrackCompletionEmail(input: {
  to: string;
  trackId: string;
  trackTitle: string;
  creatorName: string;
  masterDownloadUrl: string;
  generatedAt?: Date;
}): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.error("RESEND_API_KEY is not configured");
    return { ok: false, reason: "not_configured" };
  }

  const to = input.to.trim();
  if (!to.includes("@")) return { ok: false, reason: "no_recipient" };

  const masterDownloadUrl = input.masterDownloadUrl.trim();
  if (!masterDownloadUrl) return { ok: false, reason: "no_master_url" };

  const trackTitle = input.trackTitle.trim() || "Untitled Track";
  const generatedAt = input.generatedAt ?? new Date();
  const origin = defaultSiteOrigin();
  const vaultUrl = `${origin}/vault`;

  try {
    const certificate = buildCertificateOfCreationPdf({
      trackTitle,
      creatorName: input.creatorName,
      generatedAt,
      reference: input.trackId,
    });

    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      {
        from: CLEARANCE_EMAIL_FROM,
        to,
        replyTo: SESSION_EMAIL_REPLY_TO,
        subject: `Your Vision Lives — Congratulations on “${trackTitle}”`,
        react: TrackCreationEmail({
          trackTitle,
          creatorName: input.creatorName,
          generatedAtLabel: formatEmailDate(generatedAt),
          masterDownloadUrl,
          vaultUrl,
        }),
        attachments: [
          {
            filename: certificate.filename,
            content: certificate.bytes,
            contentType: "application/pdf",
          },
        ],
      },
      { idempotencyKey: `track-ready/${input.trackId}` },
    );

    if (error) {
      console.error("Resend track completion email failed:", error);
      return { ok: false, reason: error.message ?? "send_failed" };
    }
    return { ok: true };
  } catch (err) {
    console.error("Resend track completion email threw:", err);
    return { ok: false, reason: "send_failed" };
  }
}

/**
 * Silent backend dispatch when a studio master settles complete.
 * Looks up the registered account email, attaches Certificate of Creation,
 * and never throws / never surfaces UI.
 */
export async function sendTrackCompletionReceipt(input: {
  userId: string;
  trackId: string;
  trackTitle: string;
  masterDownloadUrl: string;
  fallbackEmail?: string | null;
  generatedAt?: Date;
}): Promise<void> {
  try {
    const to = input.fallbackEmail?.includes("@")
      ? input.fallbackEmail.trim()
      : await resolveAccountEmail(input.userId);
    if (!to) {
      console.warn("[track completion email] no recipient for", input.trackId);
      return;
    }
    const creatorName = await resolveCreatorName(input.userId, to);
    await sendTrackCompletionEmail({
      to,
      trackId: input.trackId,
      trackTitle: input.trackTitle,
      creatorName,
      masterDownloadUrl: input.masterDownloadUrl,
      generatedAt: input.generatedAt,
    });
  } catch (err) {
    console.error("Track completion receipt send failed", err);
  }
}

/** On-demand vault master link. No audio attachment and no PDF. */
const VAULT_MASTER_EMAIL_FROM = "Hybrid AI Records <support@hybrid-ai-records.com>";
const VAULT_RESEND_TEST_FROM = "Hybrid AI Records <onboarding@resend.dev>";

function mailboxAddress(value: string): string {
  return (value.match(/<([^>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

/**
 * onboarding@resend.dev only when RESEND_FROM or an existing dev flag already
 * marks this Resend account as test mode. Production stays on support@.
 */
function vaultResendTestFrom(): string | null {
  const configured = process.env.RESEND_FROM?.trim() ?? "";
  const address = mailboxAddress(configured);
  if (address === "onboarding@resend.dev" || address.endsWith("@resend.dev")) {
    return VAULT_RESEND_TEST_FROM;
  }
  const flag = (process.env.RESEND_TEST_MODE ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes" || flag === "test" || flag === "onboarding") {
    return VAULT_RESEND_TEST_FROM;
  }
  return null;
}

function supportSenderRejected(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes("support@hybrid-ai-records.com") || /\bsupport@/.test(text)) return true;
  const aboutFrom = /\bfrom\b/.test(text) || text.includes("sender");
  const rejected =
    text.includes("invalid") ||
    text.includes("verif") ||
    text.includes("domain") ||
    text.includes("not allowed") ||
    text.includes("validation") ||
    text.includes("rejected") ||
    text.includes("denied");
  return aboutFrom && rejected;
}

function resendErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message.trim() : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function vaultMasterDownloadHtml(input: {
  trackTitle: string;
  trackId: string;
  downloadUrl: string;
}): string {
  const title = escapeHtml(input.trackTitle);
  const trackId = escapeHtml(input.trackId);
  const href = escapeHtml(input.downloadUrl);
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Audio Master Download</title>
  </head>
  <body style="margin:0;padding:0;background:#fafafa;color:#18181b;font-family:Inter,Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafa;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
            <tr>
              <td style="padding:28px 28px 8px;">
                <p style="margin:0;font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#71717a;">Hybrid AI Records Vault</p>
                <h1 style="margin:12px 0 0;font-size:22px;line-height:1.3;color:#18181b;">Your master is ready to download</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 0;">
                <p style="margin:16px 0 0;font-size:13px;color:#52525b;">Track</p>
                <p style="margin:4px 0 0;font-size:18px;font-weight:600;color:#18181b;">${title}</p>
                <p style="margin:16px 0 0;font-size:13px;color:#52525b;">Vault ID</p>
                <p style="margin:4px 0 0;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#18181b;">${trackId}</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 8px;">
                <a href="${href}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:600;">Download Master Audio</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 28px 28px;">
                <p style="margin:0;font-size:13px;line-height:1.5;color:#52525b;">This link expires in 48 hours.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendVaultMasterDownloadEmail(input: {
  to: string;
  trackId: string;
  trackTitle: string;
  downloadUrl: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.error("RESEND_API_KEY is not configured");
    return { ok: false, reason: "not_configured" };
  }

  const to = input.to.trim();
  if (!to.includes("@")) return { ok: false, reason: "no_recipient" };

  const downloadUrl = input.downloadUrl.trim();
  if (!downloadUrl.startsWith("https://")) return { ok: false, reason: "send_failed" };

  const trackTitle = input.trackTitle.replace(/[\r\n\t]+/g, " ").trim().slice(0, 180) || "Untitled";
  const trackId = input.trackId.trim() || "unknown";
  const html = vaultMasterDownloadHtml({ trackTitle, trackId, downloadUrl });
  const subject = `Audio Master Download — ${trackTitle} | Hybrid AI Records Vault`;
  const testFrom = vaultResendTestFrom();
  const primaryFrom = testFrom ?? VAULT_MASTER_EMAIL_FROM;

  try {
    const resend = new Resend(apiKey);
    const first = await resend.emails.send({ from: primaryFrom, to, subject, html });
    if (!first.error) return { ok: true };

    const firstMessage = resendErrorText(first.error);
    const retryClearance =
      !testFrom && primaryFrom === VAULT_MASTER_EMAIL_FROM && supportSenderRejected(firstMessage);
    if (retryClearance) {
      const second = await resend.emails.send({ from: CLEARANCE_EMAIL_FROM, to, subject, html });
      if (!second.error) return { ok: true };
      console.error("Vault master email failed");
      return { ok: false, reason: resendErrorText(second.error) || "send_failed" };
    }

    console.error("Vault master email failed");
    return { ok: false, reason: firstMessage || "send_failed" };
  } catch {
    console.error("Vault master email failed");
    return { ok: false, reason: "send_failed" };
  }
}
