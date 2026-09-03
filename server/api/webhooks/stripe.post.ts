import { defineEventHandler, readRawBody, getHeader, createError } from "h3";
import { handleStripeWebhook } from "@/lib/stripe-webhook-fulfill.server";

export default defineEventHandler(async (event) => {
  const sig = getHeader(event, "stripe-signature");
  const rawBody = await readRawBody(event);
  if (!sig || !rawBody) {
    throw createError({ statusCode: 400, statusMessage: "Missing signature or body" });
  }
  const request = new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
  });
  const response = await handleStripeWebhook(request);
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: "Webhook Error" }))) as {
      error?: string;
    };
    throw createError({
      statusCode: response.status,
      statusMessage: payload.error || "Webhook Error",
    });
  }
  return { received: true };
});
