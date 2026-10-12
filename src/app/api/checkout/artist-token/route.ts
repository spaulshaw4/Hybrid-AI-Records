import Stripe from "stripe";
import { resolveStudioSession } from "@/lib/studio-request-auth.server";
import { allowedOrigin, defaultSiteOrigin } from "@/lib/site-origin.server";

/** Pinned to the same version as billing checkout and src/lib/stripe.server.ts. */
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

const PRODUCT_NAME = "Artist Support Token ($1.00)";
const SIGN_IN_REQUIRED = "Please sign in to buy an Artist Token.";
const MISSING_TARGET = "artistId and trackId are required.";

function isUnauthorized(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: string }).name;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : "";
  return name === "UnauthorizedSessionError" || status === 401 || message === "Unauthorized session";
}

function checkoutField(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\r\n\0]/g, " ").trim().slice(0, 200);
}

function checkoutEmail(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  const value = email.trim();
  if (!value.includes("@") || value.includes(" ") || value.length > 320) return "";
  return value;
}

/**
 * One-time $1 catalog support token. Amount is server-owned price_data.
 * buyerId in the body is ignored; metadata.buyerId is the session user.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    let session: Awaited<ReturnType<typeof resolveStudioSession>>;
    try {
      session = await resolveStudioSession(req);
    } catch (err) {
      if (isUnauthorized(err)) {
        return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
      }
      throw err;
    }

    const buyerId = session.userId?.trim() ?? "";
    if (!buyerId || buyerId === "guest_user") {
      return Response.json({ error: SIGN_IN_REQUIRED }, { status: 401 });
    }

    const body = (await req.json()) as { artistId?: unknown; trackId?: unknown };
    const artistId = checkoutField(body.artistId);
    const trackId = checkoutField(body.trackId);
    if (!artistId || !trackId) {
      return Response.json({ error: MISSING_TARGET }, { status: 400 });
    }

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (!secretKey) {
      return Response.json({ error: "Stripe is not configured." }, { status: 500 });
    }

    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const origin = allowedOrigin(req.headers.get("origin")) ?? defaultSiteOrigin();
    const email = checkoutEmail(session.email);
    const metadata = {
      type: "artist_token",
      artistId,
      trackId,
      buyerId,
    };
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 100,
            product_data: { name: PRODUCT_NAME },
          },
        },
      ],
      success_url: `${origin}/portal?tab=catalog_merch&payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/portal?tab=catalog_merch&payment=cancelled`,
      client_reference_id: buyerId,
      ...(email ? { customer_email: email } : {}),
      metadata,
    });

    return Response.json({ url: checkout.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "";
    console.error("[artist-token checkout] failed");
    const safe =
      message && !/supabase|service[_ -]?role|secret|sk_live|sk_test|whsec_/i.test(message)
        ? message
        : "Could not start checkout.";
    return Response.json({ error: safe }, { status: 500 });
  }
}
