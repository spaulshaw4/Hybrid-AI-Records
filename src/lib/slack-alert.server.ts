/**
 * Server-only Slack incident alerts.
 *
 * Posts to `SLACK_ALERT_WEBHOOK_URL` when set. Missing or invalid URLs are a
 * no-op so local/dev boxes without the secret stay quiet. Failures to reach
 * Slack are logged and never thrown — alerting must not take down the caller.
 */

const SLACK_HOST = "hooks.slack.com";
const MAX_FIELD = 1800;

function webhookUrl(): string | null {
  const raw = process.env["SLACK_ALERT_WEBHOOK_URL"]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== SLACK_HOST) return null;
    if (!url.pathname.startsWith("/services/")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function clip(value: string, max = MAX_FIELD): string {
  const trimmed = value.replace(/```/g, "'''").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 12)}\n…[truncated]`;
}

function errorDetail(error: unknown): string | null {
  if (error == null) return null;
  if (error instanceof Error) return clip(error.stack || error.message);
  if (typeof error === "string") return clip(error);
  try {
    return clip(JSON.stringify(error));
  } catch {
    return clip(String(error));
  }
}

export type SlackAlertError = unknown;

export function slackAlertConfigured(): boolean {
  return webhookUrl() !== null;
}

export function buildSlackAlertPayload(message: string, error: SlackAlertError = null) {
  const detail = errorDetail(error);
  return {
    text: [
      "⚠️ *System Alert*",
      `*Message:* ${clip(message, 500)}`,
      detail ? `*Error Detail:* \`\`\`${detail}\`\`\`` : null,
      `*Timestamp:* ${new Date().toISOString()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function sendSlackAlert(message: string, error: SlackAlertError = null): Promise<void> {
  const url = webhookUrl();
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildSlackAlertPayload(message, error)),
    });
  } catch (err) {
    console.error("Failed to dispatch Slack alert:", err);
  }
}
