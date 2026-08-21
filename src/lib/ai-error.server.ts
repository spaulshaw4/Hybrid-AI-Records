/**
 * Shared AI error surfacing (server only).
 *
 * There are no demo/fallback payloads anywhere in the cinematic pipeline: when
 * a model call fails we surface the upstream status and message so the real
 * failure is debuggable. Rate-limit / quota failures are tagged with
 * QUOTA_MARKER so the UI can render a calm cooldown state instead of raw HTTP.
 */

import { QUOTA_MARKER } from "@/lib/ai-quota";
import { sendSlackAlert } from "@/lib/slack-alert.server";

export async function throwGatewayError(
  response: Response,
  label: string,
): Promise<never> {
  const body = await response.text().catch(() => "");
  let detail = body.slice(0, 600);
  try {
    const parsed = JSON.parse(body) as {
      message?: string;
      error?: { message?: string };
    };
    detail = parsed.message ?? parsed.error?.message ?? detail;
  } catch {
    /* not JSON — keep the raw text */
  }

  const retryAfter = response.headers.get("retry-after");
  const quotaHint = retryAfter ? ` Try again in about ${retryAfter}s.` : " Try again in about a minute.";

  const message =
    response.status === 429
      ? `${QUOTA_MARKER} ${label}: the AI hit its rate limit / quota.${quotaHint}`
      : response.status === 402
        ? `${QUOTA_MARKER} ${label}: the AI key is out of quota. Top it up or raise its limit.`
        : response.status === 401 || response.status === 403
          ? `${label} could not authenticate with the AI provider. Missing or invalid API key. Please check your credentials in Settings.`
        : `${label} failed [${response.status}]: ${detail || response.statusText}`;

  console.error(`${message}${detail ? ` | upstream: ${detail}` : ""}`);
  await sendSlackAlert(message);
  throw new Error(message);
}
