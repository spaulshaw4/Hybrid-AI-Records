import Stripe from "stripe";
import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { allowedOrigin, defaultSiteOrigin } from "@/lib/site-origin.server";

/** Pinned to the same version as `src/lib/stripe.server.ts` and voice-enrollment checkout. */
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

const PRODUCT_DESCRIPTION = "Master release generation token for Hybrid AI Records Studio";

const TOKEN_PACKS = {
  single: { amount: 200, name: "1 Hybrid Token", tokens: 1 },
  ep: { amount: 1000, name: "5 Hybrid Tokens (EP Pack)", tokens: 5 },
  album: { amount: 2000, name: "12 Hybrid Tokens (Album Pack)", tokens: 12 },
} as const;

type TokenTier = keyof typeof TOKEN_PACKS;

function resolveTier(raw: unknown): TokenTier {
  if (raw === "ep" || raw === "album" || raw === "single") return raw;
  return "single";
}

/**
 * Prefer the verified studio session (Bearer or auth cookie).
 * A body userId is only used when the request is unsigned, matching the
 * `{ tier, userId }` contract. An invalid bearer fails the checkout instead
 * of opening a guest session the webhook cannot credit.
 */
async function checkoutUserId(req: Request, bodyUserId: string): Promise<string> {
  const trimmed = bodyUserId.trim();
  const hasBearer = (req.headers.get("authorization") ?? "").startsWith("Bearer ");
  try {
    const session = await resolveStudioSession(req);
    const verified = session.userId.trim();
    if (verified) return verified;
  } catch (err) {
    if (hasBearer) throw err;
  }
  return trimmed || "guest_user";
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { tier?: unknown; userId?: unknown };
    const pack = TOKEN_PACKS[resolveTier(body.tier)];
    const requestedUserId = typeof body.userId === "string" ? body.userId : "";
    const userId = await checkoutUserId(req, requestedUserId);

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (!secretKey) {
      return Response.json({ error: "STRIPE_SECRET_KEY is not configured" }, { status: 500 });
    }

    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.amount,
            product_data: {
              name: pack.name,
              description: PRODUCT_DESCRIPTION,
            },
          },
        },
      ],
      success_url: `${origin}/engine?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/engine?payment=cancelled`,
      metadata: {
        tokens: String(pack.tokens),
        userId,
      },
    });

    return Response.json({ url: session.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    console.error("[Stripe Checkout Error]:", err);
    return Response.json(
      { error: message || "Failed to create checkout session" },
      { status: 500 },
    );
  }
}
