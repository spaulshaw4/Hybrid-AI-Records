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
        from: fromAddress(),
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
