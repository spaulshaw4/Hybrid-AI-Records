import Stripe from "stripe";

import { isSubscriptionTier, SUBSCRIPTION_TIERS } from "@/lib/subscription-plans";
import { allowedOrigin, defaultSiteOrigin } from "@/lib/site-origin.server";
import { resolveStudioSession } from "@/lib/studio-request-auth.server";

/** Pinned to the same version as billing checkout and src/lib/stripe.server.ts. */
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

const SIGN_IN_REQUIRED = "Please sign in to subscribe.";
const NOT_CONFIGURED = "Subscriptions are not configured.";

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

function checkoutFailure(err: unknown): Response {
  const message = err instanceof Error ? err.message : "";
  console.error("[stripe-subscription] checkout failed");
  const safe =
    message && !/supabase|service[_ -]?role|secret|sk_live|sk_test|whsec_/i.test(message)
      ? message
      : "Could not start checkout.";
  return Response.json({ error: safe }, { status: 500 });
}

type ProfileLookup = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => Promise<{
        data: { stripe_customer_id?: string | null } | null;
        error: unknown;
      }>;
    };
  };
};

/**
 * Subscription Checkout. The tier is the only client field that is read.
 * userId, priceId, email, and client_reference_id in the body are ignored.
 */
export async function POST(req: Request): Promise<Response> {
  let session: Awaited<ReturnType<typeof resolveStudioSession>>;
  try {
    session = await resolveStudioSession(req);
  } catch (err) {
    if (isUnauthorized(err)) {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }
    console.error("[stripe-subscription] session failed");
    return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
  }

  const userId = session.userId?.trim() ?? "";
  if (!userId || userId === "guest_user") {
    return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
  }

  let tier: unknown;
  try {
    const body = (await req.json()) as { tier?: unknown };
    tier = body.tier;
  } catch {
    return Response.json({ error: "Unknown subscription tier." }, { status: 400 });
  }
  if (!isSubscriptionTier(tier)) {
    return Response.json({ error: "Unknown subscription tier." }, { status: 400 });
  }

  const priceId = process.env[SUBSCRIPTION_TIERS[tier].priceEnv]?.trim() ?? "";
  if (!priceId) {
    return Response.json({ error: NOT_CONFIGURED }, { status: 503 });
  }
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!secretKey) {
    return Response.json({ error: NOT_CONFIGURED }, { status: 503 });
  }

  let email = "";
  try {
    const { data } = await session.supabase.auth.getUser(session.accessToken);
    const value = data.user?.email?.trim() ?? "";
    if (value.includes("@") && !value.includes(" ") && value.length <= 320) email = value;
  } catch {
    email = "";
  }

  let customerId = "";
  try {
    const from = session.supabase.from as unknown as (table: string) => ProfileLookup;
    if (typeof session.supabase.from === "function") {
      const { data, error } = await from("profiles")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();
      const existing = !error && typeof data?.stripe_customer_id === "string" ? data.stripe_customer_id.trim() : "";
      if (existing.startsWith("cus_")) customerId = existing;
    }
  } catch {
    customerId = "";
  }

  try {
    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
    const checkout = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${origin}/portal?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/portal?payment=cancelled`,
      client_reference_id: userId,
      ...(customerId ? { customer: customerId } : email ? { customer_email: email } : {}),
      metadata: { userId, tier },
      subscription_data: { metadata: { userId, tier } },
    });
    if (!checkout.url) {
      return Response.json({ error: "Could not start checkout." }, { status: 500 });
    }
    return Response.json({ url: checkout.url });
  } catch (err) {
    return checkoutFailure(err);
  }
}
