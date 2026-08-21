import { createServerFn } from "@tanstack/react-start";
import { limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type StripeEnv, createStripeClient, getStripeErrorMessage } from "@/lib/stripe.server";
import { vBundleFor } from "@/lib/v-tokens";

type CheckoutResult = { clientSecret: string } | { error: string };

type BalanceResult = { balance: number };

type CreditResult =
  | { ok: true; credited: number; balance: number; alreadyCredited: boolean; paid: boolean }
  | { ok: false; error: string };

/** Current signed-in user's V Token balance. */
export const getVTokenBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BalanceResult> => {
    const { data } = await context.supabase
      .from("v_token_balances")
      .select("balance")
      .eq("user_id", context.userId)
      .maybeSingle();
    return { balance: data?.balance ?? 0 };
  });

/** Starts an embedded Stripe Checkout for one V Token bundle. */
export const createVTokenCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { priceId: string; returnUrl: string; environment: StripeEnv }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.priceId)) throw new Error("Invalid priceId");
    return data;
  })
  .handler(async ({ data, context }): Promise<CheckoutResult> => {
    try {
      const bundle = vBundleFor(data.priceId);
      if (!bundle) return { error: "That V Token bundle isn't available." };

      const { allowedSiteUrl, defaultSiteOrigin } = await import("@/lib/site-origin.server");
      const returnUrl =
        allowedSiteUrl(data.returnUrl) ??
        `${defaultSiteOrigin()}/v-tokens?v_token_session={CHECKOUT_SESSION_ID}`;

      const stripe = createStripeClient(data.environment);
      const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
      if (!prices.data.length) return { error: "V Token pricing isn't published yet." };
      const price = prices.data[0];

      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: price.id, quantity: 1 }],
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: returnUrl,
        payment_intent_data: {
          description: `V Tokens — ${bundle.name} (${bundle.tokens} V Tokens)`,
        },
        managed_payments: { enabled: true },
        metadata: {
          kind: "v_tokens",
          priceId: data.priceId,
          userId: context.userId,
        },
      } as import("stripe").Stripe.Checkout.SessionCreateParams);

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

/**
 * Credits a completed V Token purchase. Idempotent: the ledger row is keyed on
 * the Stripe session id, so a refresh or replay can never double-credit.
 */
export const creditVTokenPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^cs_[A-Za-z0-9_]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data, context }): Promise<CreditResult> => {
    try {
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);

      if (session.metadata?.["kind"] !== "v_tokens") {
        return { ok: false, error: "That checkout wasn't a V Token purchase." };
      }
      if (session.metadata?.["userId"] !== context.userId) {
        return { ok: false, error: "That purchase belongs to a different account." };
      }

      const paid =
        session.payment_status === "paid" || session.payment_status === "no_payment_required";
      const bundle = vBundleFor(session.metadata?.["priceId"] ?? "");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      if (!paid || !bundle) {
        const { data: balanceRow } = await supabaseAdmin
          .from("v_token_balances")
          .select("balance")
          .eq("user_id", context.userId)
          .maybeSingle();
        return {
          ok: true,
          credited: 0,
          balance: balanceRow?.balance ?? 0,
          alreadyCredited: false,
          paid,
        };
      }

      const { data: credit, error: creditError } = await supabaseAdmin
        .rpc("credit_v_token_purchase", {
          _user_id: context.userId,
          _session_id: session.id,
          _price_id: bundle.priceId,
          _tokens: bundle.tokens,
          _amount_total: (session.amount_total ?? null) as number,
          _currency: (session.currency ?? null) as string,
        })
        .maybeSingle();

      if (creditError || !credit) {
        console.error("V Token crediting failed:", creditError?.message);
        return { ok: false, error: "Payment received, but crediting failed. Contact support." };
      }

      if (!credit.already_credited) {
        const credited = credit.credited ?? bundle.tokens;
        const balance = credit.balance ?? 0;
        const { notifyUser } = await import("./notifications.server");
        await notifyUser({
          userId: context.userId,
          kind: "token_credit",
          title: `${credited} V Tokens added`,
          body: `Your purchase is complete. ${credited} V Token${credited === 1 ? " was" : "s were"} credited to your account. New balance: ${balance}.`,
          reference: session.id,
          emailless: true,
        });
        const { sendTokenPurchaseReceipt } = await import("./resend.server");
        await sendTokenPurchaseReceipt({
          userId: context.userId,
          amount: credited,
          balance,
          tokenKind: "v",
          fallbackEmail: session.customer_details?.email ?? session.customer_email,
        });
      }

      return {
        ok: true,
        credited: credit.credited ?? 0,
        balance: credit.balance ?? 0,
        alreadyCredited: credit.already_credited ?? false,
        paid: true,
      };
    } catch (error) {
      return { ok: false, error: getStripeErrorMessage(error) };
    }
  });

/** V Token spend/top-up history for the signed-in user. */
export const getVTokenLedger = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data } = await context.supabase
      .from("v_token_ledger")
      .select("id, delta, kind, note, balance_after, created_at")
      .eq("user_id", context.userId)
      .order("created_at", { ascending: false })
      .limit(50);
    return { entries: data ?? [] };
  });

type VSpendResult =
  | { ok: true; seconds: number; tokens: number; balance: number; alreadyApplied: boolean }
  | { ok: false; error: string; tokens: number; seconds: number; balance: number | null };

/**
 * Charges V Tokens for a cinematic render. The client sends only the requested
 * duration; the token count is recomputed here with `quoteVRender`, so tampering
 * with the browser payload cannot reduce the charge.
 */
export const spendVTokensForRender = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { durationSeconds: number; idempotencyKey?: string }) => {
    if (typeof data?.durationSeconds !== "number" || !Number.isFinite(data.durationSeconds)) {
      throw new Error("Invalid duration");
    }
    const key = data.idempotencyKey;
    if (key !== undefined && !/^[A-Za-z0-9_-]{8,80}$/.test(key)) {
      throw new Error("Invalid idempotencyKey");
    }
    return data;
  })
  .handler(async ({ data, context }): Promise<VSpendResult> => {
    limitBy("spendVTokens", context.userId, RATE_LIMITS.tokenSpend, "token requests");
    const { chargeVRender } = await import("@/lib/v-render-charge.server");
    const outcome = await chargeVRender(
      context.userId,
      data.durationSeconds,
      data.idempotencyKey,
    );

    if (!outcome.ok) {
      return {
        ok: false,
        error: outcome.error ?? "Couldn't charge V Tokens. Try again.",
        tokens: outcome.tokens,
        seconds: outcome.seconds,
        balance: outcome.balance,
      };
    }

    return {
      ok: true,
      seconds: outcome.seconds,
      tokens: outcome.tokens,
      balance: outcome.balance,
      alreadyApplied: false,
    };
  });

