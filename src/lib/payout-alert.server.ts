/**
 * Resend-first payout routing alert. SMTP is a fallback that reads host/user/
 * password from env only. Never auto-sends money.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Resend } from "resend";
import {
  PAYOUT_ALERT_FROM,
  buildPayoutAlertHtml,
  buildPayoutAlertText,
  payoutAlertRecipient,
  payoutAlertSubject,
  type TokenPurchasedPayload,
} from "@/lib/fan-token-purchase";

function pythonBin(): string {
  const envBin =
    process.env.PYTHON?.trim() ||
    process.env.PYTHON312?.trim() ||
    process.env.PYTHON_PATH?.trim();
  if (envBin) return envBin;
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe")
    : "";
  if (local && existsSync(local)) return local;
  return "python";
}

function runJsonScript(
  scriptName: string,
  payload: unknown,
  extraEnv?: Record<string, string>,
): Promise<{ ok: boolean; raw: string }> {
  const script = path.resolve(process.cwd(), "scripts", scriptName);
  return new Promise((resolve) => {
    const child = spawn(pythonBin(), [script], {
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      console.error("Payout helper spawn failed:", err);
      resolve({ ok: false, raw: "" });
    });
    child.on("close", () => {
      resolve({ ok: child.exitCode === 0, raw: (stdout || stderr).trim() });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function sendViaSmtp(input: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<{ ok: boolean; reason?: string }> {
  const host = process.env.SMTP_HOST?.trim();
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD;
  if (!host || !user || !password) return { ok: false, reason: "smtp_not_configured" };

  const result = await runJsonScript("send_smtp_mail.py", {
    to: input.to,
    from: PAYOUT_ALERT_FROM,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
  if (!result.ok) return { ok: false, reason: "smtp_failed" };
  try {
    const parsed = JSON.parse(result.raw || "{}") as { ok?: boolean };
    return parsed.ok ? { ok: true } : { ok: false, reason: "smtp_failed" };
  } catch {
    return { ok: false, reason: "smtp_failed" };
  }
}

export async function sendPayoutAlert(
  payload: TokenPurchasedPayload,
): Promise<{ ok: boolean; reason?: string }> {
  const to = payoutAlertRecipient();
  const subject = payoutAlertSubject(payload.data);
  const text = buildPayoutAlertText(payload.data);
  const html = buildPayoutAlertHtml(payload.data);
  const apiKey = process.env.RESEND_API_KEY?.trim();

  if (apiKey) {
    try {
      const resend = new Resend(apiKey);
      const { error } = await resend.emails.send(
        {
          from: PAYOUT_ALERT_FROM,
          to: [to],
          subject,
          html,
          text,
        },
        { idempotencyKey: `payout-alert/${payload.data.transaction_id}`.slice(0, 256) },
      );
      if (!error) return { ok: true };
      console.error("Resend payout alert failed:", error.message ?? error);
    } catch (err) {
      console.error("Resend payout alert threw:", err);
    }
  } else {
    console.error("RESEND_API_KEY is not configured; trying SMTP fallback for payout alert");
  }

  return sendViaSmtp({ to, subject, text, html });
}
