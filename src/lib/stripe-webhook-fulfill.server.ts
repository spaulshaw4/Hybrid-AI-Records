/**
 * Stripe webhook: verify signature, parse fan-token routing metadata, persist
 * Status = 'Pending Payout', alert Stephen. Does not send money.
 */
import Stripe from "stripe";
import { fulfillFanTokenPurchase, parseTokenPurchased } from "@/lib/fan-token-purchase";
import { recordPendingPayout } from "@/lib/pending-payouts.server";
import { sendPayoutAlert } from "@/lib/payout-alert.server";
import { nativeStripeSecret } from "@/lib/stripe.server";

const SUCCESS_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "payment_intent.succeeded",
]);

function webhookSecrets(): string[] {
  const names = [
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_SANDBOX_WEBHOOK_SECRET",
    "STRIPE_LIVE_WEBHOOK_SECRET",
    "STRIPE_WEBHOOK_SECRET_SANDBOX",
    "STRIPE_WEBHOOK_SECRET_LIVE",
  ];
  const secrets: string[] = [];
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value && !secrets.includes(value)) secrets.push(value);
  }
  return secrets;
}

async function constructEvent(rawBody: string, signature: string): Promise<Stripe.Event> {
  const secrets = webhookSecrets();
  for (const name of ["sk_live", "STRIPE_SECRET_KEY"] as const) {
    const value = process.env[name]?.trim();
    if (value?.startsWith("whsec_") && !secrets.includes(value)) secrets.push(value);
  }

  if (secrets.length) {
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        return Stripe.webhooks.constructEvent(rawBody, signature, secret);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Webhook signature verification failed");
  }

  const apiKey = nativeStripeSecret("live") ?? nativeStripeSecret("sandbox");
  if (apiKey) {
    let parsed: { id?: unknown } = {};
    try {
      parsed = JSON.parse(rawBody) as { id?: unknown };
    } catch {
      throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (id.startsWith("evt_")) {
      const stripe = new Stripe(apiKey, { apiVersion: "2026-03-25.dahlia" });
      return await stripe.events.retrieve(id);
    }
  }

  throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
}

export async function handleStripeWebhook(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  if (!signature || !rawBody) {
    return Response.json({ error: "Missing signature or body" }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = await constructEvent(rawBody, signature);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Webhook Error";
    console.error("Stripe webhook signature failed");
    return Response.json({ error: message }, { status: 400 });
  }

  if (!SUCCESS_TYPES.has(event.type)) {
    return Response.json({ received: true, ignored: event.type });
  }

  const purchase = parseTokenPurchased(event);
  if (!purchase) {
    return Response.json({ received: true, payout: "skipped" });
  }

  try {
    const result = await fulfillFanTokenPurchase(purchase, {
      recordPendingPayout,
      sendAlert: async (payload) => {
        try {
          return await sendPayoutAlert(payload);
        } catch (err) {
          console.error("Payout alert failed", err);
          return { ok: false };
        }
      },
    });
    return Response.json({
      received: true,
      payout: result.inserted ? "pending" : "already_recorded",
      alerted: result.alerted,
    });
  } catch (err) {
    console.error("Fan-token payout fulfill failed", err);
    return Response.json({ error: "Payout record failed" }, { status: 500 });
  }
}
