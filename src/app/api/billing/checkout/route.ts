import Stripe from "stripe";
import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { allowedOrigin, defaultSiteOrigin } from "@/lib/site-origin.server";

/** Pinned to the same version as `src/lib/stripe.server.ts` and voice-enrollment checkout. */
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

const PRODUCT_DESCRIPTION = "Master release generation token for Hybrid AI Records Studio";

const TOKEN_PACKS = {
  single: { amount: 200, name: "1 Hybrid Token", tokens: 1, portalReturn: false },
  ep: { amount: 1000, name: "5 Hybrid Tokens (EP Pack)", tokens: 5, portalReturn: false },
  album: { amount: 2000, name: "12 Hybrid Tokens (Album Pack)", tokens: 12, portalReturn: false },
  d5: { amount: 500, name: "5 D-Token", tokens: 5, portalReturn: true },
  d10: { amount: 1000, name: "10 D-Token", tokens: 10, portalReturn: true },
  d25: { amount: 2500, name: "25 D-Token", tokens: 25, portalReturn: true },
} as const;

type TokenTier = keyof typeof TOKEN_PACKS;

function resolveTier(raw: unknown): TokenTier {
  if (raw === "ep" || raw === "album" || raw === "single" || raw === "d5" || raw === "d10" || raw === "d25") {
    return raw;
  }
  return "single";
}

const SIGN_IN_REQUIRED =
  "Please sign in to your Hybrid AI Records account before purchasing tokens so they can be credited to your vault.";

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

/**
 * Checkout metadata must be the verified studio user. A body userId is ignored.
 * Signed-out requests are rejected so a payment cannot be stored as guest_user.
 */
async function checkoutUserId(req: Request): Promise<string | Response> {
  try {
    const session = await resolveStudioSession(req);
    const verified = session.userId.trim();
    if (!verified || verified === "guest_user") {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }
    return verified;
  } catch (err) {
    if (isUnauthorized(err)) {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }
    throw err;
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { tier?: unknown; userId?: unknown };
    const pack = TOKEN_PACKS[resolveTier(body.tier)];
    const userId = await checkoutUserId(req);
    if (userId instanceof Response) return userId;

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (!secretKey) {
      return Response.json({ error: "STRIPE_SECRET_KEY is not configured" }, { status: 500 });
    }

    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
    const returnPath = pack.portalReturn ? "/portal" : "/engine";
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
      success_url: `${origin}${returnPath}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}${returnPath}?payment=cancelled`,
      metadata: {
        tokens: String(pack.tokens),
        userId,
        ...(pack.portalReturn ? { pack: resolveTier(body.tier) } : {}),
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
