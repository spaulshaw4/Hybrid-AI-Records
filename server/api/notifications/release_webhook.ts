import { createError, defineEventHandler, getHeader, readBody } from "h3";
import { handleReleaseWebhook } from "@/lib/release-webhook.server";

export default defineEventHandler(async (event) => {
  const headers = new Headers({ "content-type": "application/json" });
  const userId = getHeader(event, "x-user-id");
  if (userId) headers.set("x-user-id", userId);
  const executeSecret =
    getHeader(event, "x-execute-secret") || getHeader(event, "x-hybrid-execute-secret");
  if (executeSecret) headers.set("x-execute-secret", executeSecret);

  const body = await readBody(event);
  const request = new Request("http://localhost/api/notifications/release", {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const response = await handleReleaseWebhook(request);
  const payload = await response.json().catch(() => ({ error: "Release notify failed" }));
  if (!response.ok) {
    throw createError({
      statusCode: response.status,
      statusMessage: (payload as { error?: string }).error || "Release notify failed",
      data: payload,
    });
  }
  return payload;
});
