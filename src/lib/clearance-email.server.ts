/**
 * Commercial clearance letters. Visible copy is fixed.
 * Mail never fails the vault write that triggered it.
 */
import { Resend } from "resend";
import {
  buildClearanceCertificateModel,
  clearanceCertificateFilename,
  renderClearanceCertificatePdf,
} from "@/lib/clearance-certificate.server";
import { SESSION_EMAIL_REPLY_TO } from "@/lib/session-email-identity";

export const CLEARANCE_EMAIL_FROM = "Hybrid AI Records <clearance@hybrid-ai-records.com>";

export type ClearanceTier = "instrumental" | "ai_voice" | "verified_vocal";

const SIGN_OFF = `Warm regards,
Stephen P. Shaw
Executive Producer & CEO
Hybrid AI Records LLC
hybrid-ai-records.com`;

const LETTER_1 = `Dear Creator,

First and foremost, thank you for creating your music with Hybrid AI Records. We built this platform from the ground up for artists—we are for the artist, and our entire infrastructure exists to give you the sonic tools to build without boundaries. The creativity and arrangement behind {{track_title}} are outstanding.

Attached to this email, you will find your official Master Clearance Certificate & Grant of Rights (PDF).

Because this production is an instrumental work generated under our enterprise studio license, it is completely free of third-party vocal liabilities and cleared for unconditional commercial exploitation.

Summary of Attached Credentials:
Track Title: {{track_title}}
Master Vault ID: {{master_id}}
Assigned ISRC: {{isrc_code}}
Clearance Level: Tier 1 — Full Commercial & Distribution Clearance
Attached Deliverable: {{sanitized_filename}}

How to Use Your Attached Certificate:
Your attached PDF serves as both Section I: Proof of Studio Authenticity (verifying origin through our licensed architecture) and Section II: Grant of Commercial Distribution Rights (authorizing worldwide streaming, sync licensing, and broadcast monetization).

You have total freedom over your music. You may distribute this release directly through Hybrid AI Records or export it to any external distributor or aggregator of your choice (DistroKid, TuneCore, CD Baby, and others). If your aggregator requests proof of licensing or chain of title, simply upload the attached certificate.

Keep building. The floor is yours.

${SIGN_OFF}`;

const LETTER_2 = `Dear Creator,

Thank you for choosing Hybrid AI Records to build your music. We created this studio because we believe in artists and the pure excitement of sonic exploration. Hearing what creators bring to life with our engine is inspiring, and the imagination behind {{track_title}} is remarkable.

Attached to this email is your official Studio Authenticity & Sandbox License Certificate (PDF).

We are also sharing this note to give you complete transparency regarding current music industry distribution policies and save you a massive headache down the road.

Summary of Attached Credentials:
Track Title: {{track_title}}
Master Vault ID: {{master_id}}
Clearance Level: Tier 2 — Personal & Social License (DSP Distribution Restricted)
Attached Deliverable: {{sanitized_filename}}

Why This Border Exists (Saving You the Headache):
Major global streaming platforms (such as Spotify and Apple Music) and commercial aggregators have established strict policies against unverified synthetic voices. Attempting to ingest purely synthetic vocal masters without verified human songwriting frequently results in automated copyright flags, frozen royalty accounts, or distributor bans.

Because we are in your corner as an artist-first platform, we will not lead you into that trap. As detailed in Section II of your attached certificate, this track is not cleared for commercial DSP streaming networks. Hybrid AI Records LLC accepts no legal or financial liability for takedowns, distributor penalties, or rejected ingestions resulting from unauthorized third-party submissions of synthetic vocal masters.

Where You Can Use This Music Right Now:
Your attached certificate certifies this master for personal listening, portfolios, creative experimentation, and background audio on your personal social media video channels (TikTok, YouTube Shorts, Instagram Reels).

Want Full Commercial Distribution? If you wrote the lyrics yourself, verify your lyric authorship inside your dashboard to unlock a Tier 3 Commercial Certificate. Alternatively, replace the vocal stem with a human vocal performance to clear the master for commercial release worldwide.

We built this platform so you could create without limits. Keep experimenting, keep having fun, and keep pushing your sound.

${SIGN_OFF}`;

const LETTER_3 = `Dear Creator,

Thank you for trusting Hybrid AI Records with your art. We built this platform for artists, songwriters, and visionaries who invest their talent into real songwriting. Your original lyrical work and human creative direction on {{track_title}} are outstanding—this is the exact blend of human artistry and studio technology our label was founded to champion.

Attached to this email is your official Certified Commercial Master & Publishing Clearance (PDF).

Summary of Attached Credentials:
Track Title: {{track_title}}
Registered Author / Lyricist: {{artist_name}}
Master Vault ID: {{master_id}}
Assigned ISRC: {{isrc_code}}
Clearance Level: Tier 3 — Certified Original Master (Unconditional Commercial Rights)
Attached Deliverable: {{sanitized_filename}}

Commercial Release & Freedom of Distribution:
Your attached document provides complete legal backing across two formal pillars:
Section I: Proof of Studio Authenticity — Verifying the recording was produced under official, authorized Hybrid AI Records infrastructure.
Section II: Grant of Commercial Distribution Rights — Granting unconditional authority to monetize, stream, sync, and distribute this master worldwide.

You maintain full ownership and autonomy over your music. You are welcome to submit this release through the Hybrid AI Records distribution network, or take your audio files and the attached PDF directly to any outside distributor or aggregator of your choice. Whenever an aggregator requests chain-of-title documentation or mechanical proof, present the attached certificate.

Congratulations on an outstanding record. We can't wait to see where you take it.

${SIGN_OFF}`;

const sentTrackIds = new Set<string>();

export function resetClearanceEmailLedger(): void {
  sentTrackIds.clear();
}

export function clearanceSubject(tier: ClearanceTier, trackTitle: string): string {
  const title = trackTitle.trim() || "Untitled";
  if (tier === "instrumental") {
    return `Commercial Clearance & Rights Grant — ${title} | Hybrid AI Records`;
  }
  if (tier === "ai_voice") {
    return `Studio Authenticity & Compliance Notice — ${title} | Hybrid AI Records`;
  }
  return `Certified Master Clearance & Rights Grant — ${title} | Hybrid AI Records`;
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, key: string) => values[key] ?? "");
}

/** Real ISRC text, or the pending label. Never manufactures a code. */
export function assignedIsrc(isrc: string | null | undefined): string {
  const value = typeof isrc === "string" ? isrc.trim() : "";
  return value || "Pending assignment";
}

export function buildClearanceLetter(input: {
  tier: ClearanceTier;
  trackTitle: string;
  masterId: string;
  isrc?: string | null;
  artistName?: string | null;
}): { subject: string; text: string; html: string; filename: string } {
  const trackTitle = input.trackTitle.trim() || "Untitled";
  const masterId = input.masterId.trim();
  const artistName = input.artistName?.trim() || "Creator";
  const filename = clearanceCertificateFilename(input.trackTitle);
  const shared = {
    track_title: trackTitle,
    master_id: masterId,
    artist_name: artistName,
    isrc_code: assignedIsrc(input.isrc),
    sanitized_filename: filename,
  };
  const template = input.tier === "instrumental" ? LETTER_1 : input.tier === "ai_voice" ? LETTER_2 : LETTER_3;
  const text = fill(template, shared);
  return {
    subject: clearanceSubject(input.tier, trackTitle),
    text,
    html: plainTextToHtml(text),
    filename,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plainTextToHtml(text: string): string {
  const paragraphs = text.split(/\n{2,}/).map((block) => {
    const inner = escapeHtml(block).replace(/\n/g, "<br>");
    return `<p style="margin:0 0 16px;">${inner}</p>`;
  });
  return `<!DOCTYPE html><html lang="en"><body style="font-family:Georgia,serif;font-size:16px;line-height:1.5;color:#111111;">${paragraphs.join("")}</body></html>`;
}

function idempotencyKey(trackId: string): string {
  const cleaned = trackId.replace(/[^\w:.-]+/g, "-").slice(0, 200);
  return `clearance/${cleaned}`;
}

export async function sendCommercialClearanceEmail(input: {
  to: string;
  tier: ClearanceTier;
  trackTitle: string;
  masterId: string;
  isrc?: string | null;
  createdAt: Date;
  artistName?: string | null;
  trackId: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const trackId = input.trackId.trim();
  if (!trackId) return { ok: false, reason: "no_track" };
  if (sentTrackIds.has(trackId)) return { ok: false, reason: "already_sent" };

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) {
    console.error("RESEND_API_KEY is not configured");
    return { ok: false, reason: "not_configured" };
  }

  const to = input.to.trim();
  if (!to.includes("@")) return { ok: false, reason: "no_recipient" };

  sentTrackIds.add(trackId);
  try {
    const certificate = buildClearanceCertificateModel({
      tier: input.tier,
      trackTitle: input.trackTitle,
      masterId: input.masterId,
      isrc: input.isrc,
      createdAt: input.createdAt,
      artistName: input.artistName,
    });
    const letter = buildClearanceLetter({
      tier: input.tier,
      trackTitle: input.trackTitle,
      masterId: input.masterId,
      isrc: input.isrc,
      artistName: input.artistName,
    });
    const pdfBuffer = await renderClearanceCertificatePdf(certificate);
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      {
        from: CLEARANCE_EMAIL_FROM,
        to,
        replyTo: SESSION_EMAIL_REPLY_TO,
        subject: letter.subject,
        html: letter.html,
        text: letter.text,
        attachments: [
          {
            filename: letter.filename,
            content: pdfBuffer,
          },
        ],
      },
      { idempotencyKey: idempotencyKey(trackId) },
    );
    if (error) {
      sentTrackIds.delete(trackId);
      console.error("[clearance] email failed");
      return { ok: false, reason: "send_failed" };
    }
    return { ok: true };
  } catch {
    sentTrackIds.delete(trackId);
    console.error("[clearance] email failed");
    return { ok: false, reason: "send_failed" };
  }
}
