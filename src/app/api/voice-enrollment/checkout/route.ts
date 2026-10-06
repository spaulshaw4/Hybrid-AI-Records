import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { resolveStudioSession, unauthorizedSessionResponse } from "@/lib/studio-request-auth.server";
import { defaultSiteOrigin } from "@/lib/site-origin.server";

const STRIPE_API_VERSION = "2026-03-25.dahlia" as const;
const PRODUCT_NAME = "Artist Voice Profile Activation";

function serviceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(supabaseUrl, serviceKey);
}

function voiceSamplePath(sampleAudioUrl: string, userId: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(sampleAudioUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const marker = "/voice-samples/";
  const index = parsed.pathname.indexOf(marker);
  if (index === -1) return null;
  const path = decodeURIComponent(parsed.pathname.slice(index + marker.length)).replace(/^\/+/, "");
  if (!path || path.includes("..") || !path.startsWith(`${userId}/`)) return null;
  return path;
}

function integrationIdentifier(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let suffix = "";
  for (let i = 0; i < 8; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `voice_enrollment_${suffix}`;
}

/**
 * $10 Checkout for a voice profile. Metadata carries userId and the stored sample URL only.
 * The charge stays on the platform. Nothing is transferred to WaveSpeed from Stripe.
 */
export async function POST(req: Request): Promise<Response> {
  let sessionUserId = "";
  try {
    const session = await resolveStudioSession(req);
    sessionUserId = session.userId;
  } catch {
    return unauthorizedSessionResponse();
  }

  try {
    const body = (await req.json()) as { sampleAudioUrl?: unknown };
    const sampleAudioUrl = typeof body.sampleAudioUrl === "string" ? body.sampleAudioUrl.trim() : "";
    const samplePath = voiceSamplePath(sampleAudioUrl, sessionUserId);
    if (!samplePath) {
      return Response.json(
        { error: "A stored voice sample is required before checkout." },
        { status: 400 },
      );
    }

    const supabase = serviceClient();
    const { data: sample, error: sampleError } = await supabase.storage
      .from("voice-samples")
      .download(samplePath);
    if (sampleError || !sample || sample.size < 32) {
      return Response.json(
        { error: "Voice sample is missing; checkout was not started." },
        { status: 400 },
      );
    }

    const { error: profileError } = await supabase.from("artist_profiles").insert({
      user_id: sessionUserId,
      is_voice_enrolled: false,
    });
    if (profileError && profileError.code !== "23505") {
      throw new Error(profileError.message);
    }

    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (!secretKey) {
      return Response.json({ error: "STRIPE_SECRET_KEY is not configured" }, { status: 500 });
    }
    const stripe = new Stripe(secretKey, { apiVersion: STRIPE_API_VERSION });
    const origin = defaultSiteOrigin();
    const checkout = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 1000,
            product_data: { name: PRODUCT_NAME },
          },
        },
      ],
      success_url: `${origin}/studio?voice_enrollment=1`,
      cancel_url: `${origin}/studio?voice_enrollment=cancelled`,
      client_reference_id: sessionUserId,
      metadata: {
        userId: sessionUserId,
        sampleAudioUrl,
      },
      integration_identifier: integrationIdentifier(),
    } as Stripe.Checkout.SessionCreateParams);

    return Response.json({ url: checkout.url });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Checkout failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
