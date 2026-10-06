import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const VOCAL_CLONE_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/vocal-clone";
const STRIPE_API_VERSION = "2026-03-25.dahlia" as Stripe.LatestApiVersion;

type EnrollmentSession = {
  metadata?: {
    userId?: string;
    sampleAudioUrl?: string;
  } | null;
};

function vaultClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";

  let event: Stripe.Event;
  try {
    if (!sig || !webhookSecret) {
      throw new Error("Missing stripe-signature or STRIPE_WEBHOOK_SECRET");
    }
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

  if (event.type !== "checkout.session.completed") {
    return Response.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session & EnrollmentSession;
  const userId = session.metadata?.userId?.trim() ?? "";
  if (!userId) {
    return Response.json({ error: "Missing userId in metadata" }, { status: 400 });
  }
  const sampleAudioUrl = session.metadata?.sampleAudioUrl?.trim() ?? "";

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
