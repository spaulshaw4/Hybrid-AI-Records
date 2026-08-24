import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
const NOTIFY_TO = "Hybrid.AI.Records@proton.me";

const applicationSchema = z.object({
  artist: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(255),
  packageLabel: z.string().trim().min(1).max(200),
  fileName: z.string().trim().max(300).optional().nullable(),
  link: z.string().trim().max(600).optional().nullable(),
  notes: z.string().trim().max(4000).optional().nullable(),
  acknowledged: z.boolean(),
  reference: z.string().trim().max(40).optional().nullable(),
  statusUrl: z.string().trim().max(400).optional().nullable(),
  // Base64 (no data: prefix) of the generated receipt PDF, attached to the
  // artist's confirmation email. Capped so a bad payload can't blow up a send.
  receiptPdfBase64: z.string().max(6_000_000).optional().nullable(),
  receiptPdfName: z.string().trim().max(200).optional().nullable(),
});

function esc(v: string) {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const sendApplicationEmail = createServerFn({ method: "POST" })
  .validator((data: unknown) => applicationSchema.parse(data))
  .handler(async ({ data }) => {
    const lovableKey = process.env.LOVABLE_API_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    // The submission row is written before this call, so a mail problem is a
    // notification failure, not a lost application. Report it instead of
    // throwing, and let the UI confirm receipt with a warning.
    if (!lovableKey || !resendKey) {
      console.error("Email service is not configured");
      return { ok: false, receiptSent: false, reason: "not_configured" as const };
    }


    const subject = `New Project Submission: ${data.artist} - ${data.packageLabel}`;
    const fileLine = data.fileName
      ? `${esc(data.fileName)} <em>(attached in application form — retrieve from artist if needed)</em>`
      : "<em>No file uploaded</em>";
    const linkLine = data.link
      ? `<a href="${esc(data.link)}">${esc(data.link)}</a>`
      : "<em>None provided</em>";
    const notes = data.notes ? esc(data.notes).replace(/\n/g, "<br/>") : "<em>None</em>";
    const ack = data.acknowledged
      ? "✅ Agreed — video rendering is non-refundable once rendering begins."
      : "❌ NOT agreed";

    const html = `
      <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5;">
        <h2 style="margin:0 0 16px;color:#e11d2e;">New Project Submission</h2>
        <table cellpadding="8" style="border-collapse:collapse;width:100%;max-width:640px;">
          ${data.reference ? `<tr><td style="border:1px solid #ddd;"><strong>Reference</strong></td><td style="border:1px solid #ddd;">${esc(data.reference)}</td></tr>` : ""}
          <tr><td style="border:1px solid #ddd;"><strong>Artist / Band</strong></td><td style="border:1px solid #ddd;">${esc(data.artist)}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Contact Email</strong></td><td style="border:1px solid #ddd;"><a href="mailto:${esc(data.email)}">${esc(data.email)}</a></td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Package Selected</strong></td><td style="border:1px solid #ddd;">${esc(data.packageLabel)}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Lyrics / Audio File</strong></td><td style="border:1px solid #ddd;">${fileLine}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>External Link</strong></td><td style="border:1px solid #ddd;">${linkLine}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Project Notes / Vision</strong></td><td style="border:1px solid #ddd;">${notes}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Video Policy</strong></td><td style="border:1px solid #ddd;">${ack}</td></tr>
        </table>
      </div>
    `;

    const response = await fetch(`${GATEWAY_URL}/emails`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lovableKey}`,
        "X-Connection-Api-Key": resendKey,
      },
      body: JSON.stringify({
        from: "Hybrid AI Records <onboarding@resend.dev>",
        to: [NOTIFY_TO],
        reply_to: data.email,
        subject,
        html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`Resend send failed [${response.status}]: ${body}`);
      return { ok: false, receiptSent: false, reason: `send_failed_${response.status}` };
    }


    // Confirmation receipt to the artist. A failure here must never fail the
    // submission itself — the label already received the application.
    let receiptSent = false;
    try {
      const receiptHtml = `
        <div style="font-family:Arial,sans-serif;color:#111;line-height:1.6;">
          <h2 style="margin:0 0 8px;color:#e11d2e;">We received your submission</h2>
          <p style="margin:0 0 16px;">Thanks, ${esc(data.artist)} — your project is now in the Hybrid AI Records review queue. Keep this email as your receipt.</p>
          ${data.reference ? `<p style="margin:0 0 16px;padding:12px;background:#f5f5f5;border-left:4px solid #e11d2e;"><strong>Your reference code:</strong> ${esc(data.reference)}${data.statusUrl ? `<br/><a href="${esc(data.statusUrl)}">Track your request status</a> (you will need this code and this email address).` : ""}</p>` : ""}
          <h3 style="margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#555;">Summary of what you sent</h3>
          <table cellpadding="8" style="border-collapse:collapse;width:100%;max-width:640px;">
            <tr><td style="border:1px solid #ddd;"><strong>Artist / Band</strong></td><td style="border:1px solid #ddd;">${esc(data.artist)}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Contact Email</strong></td><td style="border:1px solid #ddd;">${esc(data.email)}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Package</strong></td><td style="border:1px solid #ddd;">${esc(data.packageLabel)}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Attachment</strong></td><td style="border:1px solid #ddd;">${fileLine}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Reference Link</strong></td><td style="border:1px solid #ddd;">${linkLine}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Notes / Vision</strong></td><td style="border:1px solid #ddd;">${notes}</td></tr>
            <tr><td style="border:1px solid #ddd;"><strong>Policy Acknowledgment</strong></td><td style="border:1px solid #ddd;">${ack}</td></tr>
          </table>
          <h3 style="margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:1px;color:#555;">What happens next</h3>
          <ol style="margin:0 0 16px;padding-left:20px;">
            <li><strong>Review (1-2 business days).</strong> Our team listens to your material and checks package fit.</li>
            <li><strong>Reply with a plan.</strong> You get scope, timeline, and pricing confirmation by email.</li>
            <li><strong>Approve and kick off.</strong> Once you approve, production starts and you receive checkpoints.</li>
            <li><strong>Delivery.</strong> Final masters (and video, if included) are delivered release-ready.</li>
          </ol>
          ${data.receiptPdfBase64 ? `<p style="margin:0 0 16px;">Your full submission receipt is attached to this email as a PDF.</p>` : ""}
          <p style="margin:0 0 8px;">Questions or corrections? Just reply to this email and it reaches the Hybrid team directly.</p>
          <p style="margin:16px 0 0;color:#777;font-size:12px;">Hybrid AI Records LLC — this is an automated confirmation receipt.</p>
        </div>
      `;

      const receipt = await fetch(`${GATEWAY_URL}/emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": resendKey,
        },
        body: JSON.stringify({
          from: "Hybrid AI Records <onboarding@resend.dev>",
          to: [data.email],
          reply_to: NOTIFY_TO,
          subject: `Received: ${data.artist} — ${data.packageLabel}`,
          html: receiptHtml,
          ...(data.receiptPdfBase64
            ? {
                attachments: [
                  {
                    filename: data.receiptPdfName || "hybrid-ai-records-receipt.pdf",
                    content: data.receiptPdfBase64,
                    content_type: "application/pdf",
                  },
                ],
              }
            : {}),
        }),
      });

      if (receipt.ok) {
        receiptSent = true;
      } else {
        console.error(
          `Artist receipt send failed [${receipt.status}]: ${await receipt.text()}`,
        );
      }
    } catch (err) {
      console.error("Artist receipt send threw:", err);
    }

    return { ok: true, receiptSent };
  });
