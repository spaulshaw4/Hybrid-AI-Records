import Stripe from "stripe";
import { PAIR_TOPUPS, isPairTopup, type PairTopupId } from "@/lib/pair-topups";
import {
  isSingleTokenType,
  parseSingleTokenQuantity,
  SINGLE_TOKEN_PRODUCTS,
  type SingleTokenType,
} from "@/lib/single-tokens";
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

const PAIR_NOT_CONFIGURED = "Token packs are not configured.";
const SINGLE_NOT_CONFIGURED = "Token checkout is not configured.";

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

type CheckoutIdentity = { userId: string; email: string | null };

function checkoutEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  const value = email.trim();
  if (!value.includes("@") || value.includes(" ") || value.length > 320) return "";
  return value;
}

/**
 * Checkout metadata must be the verified studio user. A body userId is ignored.
 * Signed-out requests are rejected so a payment cannot be stored as guest_user.
 */
async function checkoutIdentity(req: Request): Promise<CheckoutIdentity | Response> {
  try {
    const session = await resolveStudioSession(req);
    const verified = session.userId?.trim() ?? "";
    if (!verified || verified === "guest_user") {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }
    const email = typeof session.email === "string" ? session.email : null;
    return { userId: verified, email };
  } catch (err) {
    if (isUnauthorized(err)) {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }
    throw err;
  }
}

async function checkoutUserId(req: Request): Promise<string | Response> {
  const identity = await checkoutIdentity(req);
  if (identity instanceof Response) return identity;
  return identity.userId;
}

function requestsSingleToken(body: { tokenType?: unknown }): boolean {
  return body.tokenType !== undefined && body.tokenType !== null && body.tokenType !== "";
}

/**
 * Unbundled H, D, or Artist tokens. The browser sends tokenType and quantity.
 * The Stripe Price id comes from env. A body userId or price id is ignored.
 */
async function singleTokenCheckout(
  req: Request,
  body: { tokenType?: unknown; quantity?: unknown },
): Promise<Response> {
  const identity = await checkoutIdentity(req);
  if (identity instanceof Response) return identity;

  if (!isSingleTokenType(body.tokenType)) {
    return Response.json({ error: "Invalid token type." }, { status: 400 });
  }
  const quantity = parseSingleTokenQuantity(body.quantity);
  if (quantity == null) {
    return Response.json({ error: "Invalid quantity." }, { status: 400 });
  }

  const tokenType: SingleTokenType = body.tokenType;
  const priceId = process.env[SINGLE_TOKEN_PRODUCTS[tokenType].priceEnv]?.trim() ?? "";
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!priceId || !secretKey) {
    return Response.json({ error: SINGLE_NOT_CONFIGURED }, { status: 503 });
  }

  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
  const email = checkoutEmail(identity.email);
  const metadata = {
    userId: identity.userId,
    tokenType,
    quantity: String(quantity),
  };
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity }],
    success_url: `${origin}/portal?tab=plans&payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/portal?tab=plans&payment=cancelled`,
    client_reference_id: identity.userId,
    ...(email ? { customer_email: email } : {}),
    metadata,
    payment_intent_data: { metadata },
  });

  return Response.json({ url: session.url });
}

/**
 * Pair top-ups bill a server-owned Stripe Price. A missing price env returns 503
 * and does not construct Stripe. d5/d10/d25 stay on the price_data path below.
 */
async function pairTopupCheckout(req: Request, tier: PairTopupId): Promise<Response> {
  const userId = await checkoutUserId(req);
  if (userId instanceof Response) return userId;

  const pack = PAIR_TOPUPS[tier];
  const priceId = process.env[pack.priceEnv]?.trim() ?? "";
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (!priceId || !secretKey) {
    return Response.json({ error: PAIR_NOT_CONFIGURED }, { status: 503 });
  }

  const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
  const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${origin}/portal?tab=plans&payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/portal?tab=plans&payment=cancelled`,
    metadata: {
      tokens: String(pack.hybridTokens),
      dTokens: String(pack.dTokens),
      userId,
      pack: tier,
      kind: "pair_topup",
    },
  });

  return Response.json({ url: session.url });
}

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      tier?: unknown;
      userId?: unknown;
      tokenType?: unknown;
      quantity?: unknown;
    };
    if (requestsSingleToken(body)) {
      return await singleTokenCheckout(req, body);
    }
    if (isPairTopup(body.tier)) {
      return await pairTopupCheckout(req, body.tier);
    }
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
