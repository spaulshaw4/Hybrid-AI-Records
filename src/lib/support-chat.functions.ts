import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const GATEWAY_URL = "https://connector-gateway.lovable.dev/resend";
const NOTIFY_TO = "Hybrid.AI.Records@proton.me";

const supportSchema = z.object({
  artist: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(255),
  topic: z.enum([
    "Vocal Submission",
    "Package Question",
    "Label Distribution",
    "General Inquiry",
  ]),
  message: z.string().trim().min(1).max(4000),
});

function esc(v: string) {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const sendSupportMessage = createServerFn({ method: "POST" })
  .validator((data: unknown) => supportSchema.parse(data))
  .handler(async ({ data }) => {
    const lovableKey = process.env['LOVABLE_API_KEY'];
    const resendKey = process.env['RESEND_API_KEY'];
    if (!lovableKey || !resendKey) {
      throw new Error("Email service is not configured");
    }

    const html = `
      <div style="font-family:Arial,sans-serif;color:#111;line-height:1.5;">
        <h2 style="margin:0 0 16px;color:#e11d2e;">Artist Support Chat</h2>
        <table cellpadding="8" style="border-collapse:collapse;width:100%;max-width:640px;">
          <tr><td style="border:1px solid #ddd;"><strong>Artist</strong></td><td style="border:1px solid #ddd;">${esc(data.artist)}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Email</strong></td><td style="border:1px solid #ddd;"><a href="mailto:${esc(data.email)}">${esc(data.email)}</a></td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Topic</strong></td><td style="border:1px solid #ddd;">${esc(data.topic)}</td></tr>
          <tr><td style="border:1px solid #ddd;"><strong>Message</strong></td><td style="border:1px solid #ddd;">${esc(data.message).replace(/\n/g, "<br/>")}</td></tr>
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
        subject: `Support Chat — ${data.topic} — ${data.artist}`,
        html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`Support message send failed [${response.status}]: ${body}`);
      throw new Error(`Email send failed [${response.status}]`);
    }

    return { ok: true as const };
  });
