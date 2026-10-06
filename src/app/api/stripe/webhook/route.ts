import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const VOCAL_CLONE_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/vocal-clone";
const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;

type EnrollmentSession = {
  metadata?: {
    userId?: string;
    sampleAudioUrl?: string;
    tokens?: string;
  } | null;
};

const LEDGER_USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function vaultClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

function positiveTokenCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/** guest_user / unknown / non-UUIDs are not auth.users rows. Do not invent one. */
function isLedgerUserId(userId: string): boolean {
  if (!userId || userId === "guest_user" || userId === "unknown") return false;
  return LEDGER_USER_ID.test(userId);
}

function priceIdForTokens(tokens: number): string {
  if (tokens === 1) return "billing_single";
  if (tokens === 5) return "billing_ep";
  if (tokens === 12) return "billing_album";
  return `billing_tokens_${tokens}`;
}

function amountTotalFor(session: Stripe.Checkout.Session, tokens: number): number {
  if (typeof session.amount_total === "number" && Number.isFinite(session.amount_total)) {
    return session.amount_total;
  }
  if (tokens === 1) return 200;
  if (tokens === 5) return 1000;
  if (tokens === 12) return 2000;
  return 0;
}

/**
 * Credits Hybrid Tokens into token_balances via credit_token_purchase
 * (unique on stripe_session_id). The stripe_webhook_events row is inserted
 * only after that write, so a retry of the same event cannot double-credit
 * and a failed credit can be retried.
 */
async function fulfillTokenPack(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  tokens: number,
): Promise<Response> {
  const userId = session.metadata?.userId?.trim() ?? "";
  console.log(`[Stripe Webhook] Payment verified. Crediting ${tokens} tokens to ${userId}`);

  const creditable = isLedgerUserId(userId);
  if (!creditable) {
    // No token_balances row for guest_user, unknown, or a non-account id.
    console.log(
      `[Stripe Webhook] Skipping token ledger write for ${userId || "missing userId"}; no account to credit.`,
    );
  }

  let supabase: ReturnType<typeof vaultClient>;
  try {
    supabase = vaultClient();
  } catch (err: unknown) {
    if (!creditable) {
      const message = err instanceof Error ? err.message : "ledger unavailable";
      console.error(`[Stripe Webhook] Skipped token credit was not recorded: ${message}`);
      return Response.json({ received: true });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }

  try {
    const { data: existing, error: lookupError } = await supabase
      .from("stripe_webhook_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (existing?.event_id) {
      return Response.json({ received: true });
    }

    if (creditable) {
      const { error: creditError } = await supabase.rpc("credit_token_purchase", {
        _user_id: userId,
        _session_id: session.id || event.id,
        _price_id: priceIdForTokens(tokens),
        _tokens: tokens,
        _amount_total: amountTotalFor(session, tokens),
        _currency: session.currency?.trim() || "usd",
      });
      if (creditError) throw new Error(creditError.message);
    }

    const { error: claimError } = await supabase
      .from("stripe_webhook_events")
      .insert({ event_id: event.id });
    if (claimError) {
      if (claimError.code === "23505") {
        return Response.json({ received: true });
      }
      throw new Error(claimError.message);
    }

    return Response.json({ received: true });
  } catch (err: unknown) {
    if (!creditable) {
      const message = err instanceof Error ? err.message : "ledger unavailable";
      console.error(`[Stripe Webhook] Skipped token credit was not recorded: ${message}`);
      return Response.json({ received: true });
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";

  if (!sig) {
    return Response.json({ error: "Webhook Error: Missing stripe-signature" }, { status: 400 });
  }
  if (!webhookSecret) {
    return Response.json({ error: "Webhook secret missing on server" }, { status: 500 });
  }

  let event: Stripe.Event;
  try {
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
    if (secretKey) {
      // Construct inside the handler so a missing key does not crash import.
      void new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    }
    event = Stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid signature";
    return Response.json({ error: `Webhook Error: ${message}` }, { status: 400 });
  }

  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded"
  ) {
    return Response.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session & EnrollmentSession;
  const tokenCount = positiveTokenCount(session.metadata?.tokens);
  const sampleAudioUrl = session.metadata?.sampleAudioUrl?.trim() ?? "";

  // Token packs and voice enrollment are different sessions. A positive
  // metadata.tokens value with no voice sample is a token pack. Voice
  // sessions (sampleAudioUrl) keep the enrollment path below.
  if (tokenCount != null && !sampleAudioUrl) {
    if (event.type === "checkout.session.completed" && session.payment_status === "unpaid") {
      console.log(
        `[Stripe Webhook] Token checkout ${session.id} is unpaid; waiting for async payment before crediting.`,
      );
      return Response.json({ received: true });
    }
    return fulfillTokenPack(event, session, tokenCount);
  }

  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true });
  }

  const userId = session.metadata?.userId?.trim() ?? "";
  if (!userId) {
    return Response.json({ error: "Missing userId in metadata" }, { status: 400 });
  }

  try {
    const supabase = vaultClient();
    const { data: existing, error: lookupError } = await supabase
      .from("stripe_webhook_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (existing?.event_id) {
      return Response.json({ received: true });
    }

    const { error: claimError } = await supabase
      .from("stripe_webhook_events")
      .insert({ event_id: event.id });
    if (claimError) {
      if (claimError.code === "23505") {
        return Response.json({ received: true });
      }
      throw new Error(claimError.message);
    }

    let enrolledVocalId = `mock_voc_${Date.now()}`;
    // Air-gap: vocal-clone runs only when the flag is exactly "true" and a sample URL was stored.
    // WaveSpeed auto-recharge ($25 when the balance drops under $10) is a dashboard setting.
    // There is no card API to call from this enrollment. The $10 stays on the platform.
    if (process.env.ENABLE_WAVESPEED_ENROLLMENT === "true" && sampleAudioUrl) {
      const apiKey = process.env.WAVESPEED_API_KEY?.trim() ?? "";
      const enrollRes = await fetch(VOCAL_CLONE_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ audio: sampleAudioUrl }),
      });
      const enrollData = (await enrollRes.json().catch(() => ({}))) as {
        data?: { vocal_id?: string };
      };
      enrolledVocalId = enrollData.data?.vocal_id || enrolledVocalId;
    }

    const { error: profileError } = await supabase.from("artist_profiles").upsert(
      {
        user_id: userId,
        vocal_id: enrolledVocalId,
        is_voice_enrolled: true,
      },
      { onConflict: "user_id" },
    );
    if (profileError) throw new Error(profileError.message);

    return Response.json({ received: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Internal server error";
    return Response.json({ error: message }, { status: 500 });
  }
}
