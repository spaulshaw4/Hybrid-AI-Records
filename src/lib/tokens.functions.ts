import { createServerFn } from "@tanstack/react-start";
import { limitBy, RATE_LIMITS } from "@/lib/rate-limit";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { type StripeEnv, createStripeClient, getStripeErrorMessage, logStripeError } from "@/lib/stripe.server";
import { bundleFor } from "@/lib/tokens";
import {
  DEFAULT_CURRENCY,
  isCurrencyCode,
  surchargePercent,
  type CurrencyCode,
} from "@/lib/pricing";
import { convertFromUsd } from "@/lib/fx";

type CheckoutResult = { clientSecret: string } | { error: string };

type BalanceResult = { balance: number };

type CreditResult =
  | { ok: true; credited: number; balance: number; alreadyCredited: boolean; paid: boolean }
  | { ok: false; error: string };

/** Current signed-in user's Hybrid Token balance. */
export const getTokenBalance = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BalanceResult> => {
    const { data } = await context.supabase
      .from("token_balances")
      .select("balance")
      .eq("user_id", context.userId)
      .maybeSingle();
    return { balance: data?.balance ?? 0 };
  });

type SpendResult =
  | { ok: true; balance: number; alreadyApplied: boolean }
  | { ok: false; error: string; balance: number };

/**
 * Spends Hybrid Tokens for one generation.
 *
 * The whole thing happens inside one database function: balance check,
 * deduction and ledger entry commit together, so a race (double-click, two
 * tabs) can never overdraw. `idempotencyKey` is the generation's run id — the
 * same run replayed after a retry or a flaky network is charged exactly once.
 */
export const spendTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { amount?: number; idempotencyKey?: string; note?: string }) => {
    const amount = Math.trunc(data?.amount ?? 1);
    if (!Number.isFinite(amount) || amount < 1 || amount > 50) throw new Error("Invalid token amount");
    const key = typeof data?.idempotencyKey === "string" ? data.idempotencyKey.trim().slice(0, 120) : "";
    const note = typeof data?.note === "string" ? data.note.trim().slice(0, 200) : "";
    return { amount, idempotencyKey: key, note };
  })
  .handler(async ({ data, context }): Promise<SpendResult> => {
    limitBy("spendTokens", context.userId, RATE_LIMITS.tokenSpend, "token requests");
    const { requireSupabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = requireSupabaseAdmin();
    const rpcArgs = {
      _user_id: context.userId,
      _amount: data.amount,
      _note: data.note || undefined,
      _idempotency_key: data.idempotencyKey || undefined,
    };
    const { data: rpcRows, error } = await admin.rpc("spend_hybrid_tokens", rpcArgs);

    const row = (Array.isArray(rpcRows) ? rpcRows[0] : rpcRows) as
      | {
          ok?: boolean | null;
          balance?: number | null;
          already_applied?: boolean | null;
          reason?: string | null;
        }
      | null
      | undefined;

    if (error || !row || typeof row.ok !== "boolean") {
      console.error("[spendTokens] spend_hybrid_tokens failed", {
        rpcArgs,
        error: error
          ? { message: error.message, code: error.code, details: error.details, hint: error.hint }
          : null,
        raw: rpcRows,
      });
      const { data: balanceRow } = await admin
        .from("token_balances")
        .select("balance")
        .eq("user_id", context.userId)
        .maybeSingle();
      return {
        ok: false,
        error: "Could not update your token balance. Try again.",
        balance: balanceRow?.balance ?? 0,
      };
    }
    if (!row.ok) {
      console.error("[spendTokens] spend_hybrid_tokens denied (402)", {
        rpcArgs,
        row,
        raw: rpcRows,
      });
      return {
        ok: false,
        error: row.reason ?? "Not enough Hybrid Tokens. Buy more to keep generating.",
        balance: row.balance ?? 0,
      };
    }
    return { ok: true, balance: row.balance ?? 0, alreadyApplied: row.already_applied ?? false };
  });

/** Admin / env token policy for the engine Test Mode toggle. */
export const getGenerationTokenPolicyFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { getGenerationTokenPolicy } = await import("@/lib/generation-tokens.server");
    return getGenerationTokenPolicy(context.userId, context.supabase);
  });

/** Admins only — when Test Mode is ON, generates burn tokens like end users. */
export const setAdminTokenTestModeFn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { enabled?: boolean }) => ({ enabled: Boolean(data?.enabled) }))
  .handler(async ({ data, context }) => {
    const { setAdminTokenTestMode } = await import("@/lib/generation-tokens.server");
    return setAdminTokenTestMode(context.userId, context.supabase, data.enabled);
  });


/** Starts an embedded Stripe Checkout for one token bundle (USD catalog or FX price_data). */
export const createTokenCheckoutSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: {
    priceId: string;
    returnUrl: string;
    environment: StripeEnv;
    currency?: CurrencyCode;
  }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.priceId)) throw new Error("Invalid priceId");
    if (data.currency && !isCurrencyCode(data.currency)) throw new Error("Invalid currency");
    return data;
  })
  .handler(async ({ data, context }): Promise<CheckoutResult> => {
    try {
      const bundle = bundleFor(data.priceId);
      if (!bundle) return { error: "That token bundle isn't available." };

      await (await import("@/lib/pricing-settings.server")).readSurchargeSettings();
      await (await import("@/lib/fx-rates.server")).readFxRates();

      const { allowedSiteUrl, defaultSiteOrigin } = await import("@/lib/site-origin.server");
      const returnUrl =
        allowedSiteUrl(data.returnUrl) ??
        `${defaultSiteOrigin()}/studio?token_session={CHECKOUT_SESSION_ID}`;

      const stripe = createStripeClient(data.environment);
      const currency: CurrencyCode = data.currency ?? DEFAULT_CURRENCY;

      type LineItem = {
        price?: string;
        price_data?: {
          currency: string;
          product_data: { name: string; description?: string };
          unit_amount: number;
        };
        quantity: number;
      };
      const lineItems: LineItem[] = [];

      if (currency === DEFAULT_CURRENCY) {
        const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
        if (prices.data.length) {
          lineItems.push({ price: prices.data[0].id, quantity: 1 });
        } else {
          // Catalog price missing — still charge via ad-hoc USD price_data.
          lineItems.push({
            price_data: {
              currency: "usd",
              product_data: {
                name: `Hybrid Tokens — ${bundle.name}`,
                description: `${bundle.tokens} Hybrid Tokens`,
              },
              unit_amount: bundle.amount,
            },
            quantity: 1,
          });
        }
      } else {
        const converted = convertFromUsd(bundle.amount, currency);
        if (converted == null || converted < 1) {
          return {
            error: `This token bundle isn't available in ${currency.toUpperCase()} right now. Switch to USD or try again shortly.`,
          };
        }
        const bps = Math.round(surchargePercent(currency) * 100);
        const unitAmount =
          bps === 0 ? converted : Math.ceil((converted * (10_000 + bps)) / 10_000);
        lineItems.push({
          price_data: {
            currency,
            product_data: {
              name: `Hybrid Tokens — ${bundle.name}`,
              description: `${bundle.tokens} Hybrid Tokens`,
            },
            unit_amount: unitAmount,
          },
          quantity: 1,
        });
      }

      const session = await stripe.checkout.sessions.create({
        line_items: lineItems,
        mode: "payment",
        ui_mode: "embedded_page",
        return_url: returnUrl,
        payment_intent_data: {
          description: `Hybrid Tokens — ${bundle.name} (${bundle.tokens} tokens)`,
        },
        managed_payments: { enabled: true },
        metadata: {
          kind: "hybrid_tokens",
          priceId: data.priceId,
          userId: context.userId,
          currency,
        },
      } as import("stripe").Stripe.Checkout.SessionCreateParams);

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      logStripeError("createTokenCheckoutSession", error);
      return { error: getStripeErrorMessage(error) };
    }
  });

/**
 * Credits a completed token purchase. Idempotent: the ledger row is keyed on
 * the Stripe session id, so a refresh or replay can never double-credit.
 */
export const creditTokenPurchase = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^cs_[A-Za-z0-9_]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data, context }): Promise<CreditResult> => {
    try {
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);

      if (session.metadata?.["kind"] !== "hybrid_tokens") {
        return { ok: false, error: "That checkout wasn't a token purchase." };
      }
      if (session.metadata?.["userId"] !== context.userId) {
        return { ok: false, error: "That purchase belongs to a different account." };
      }

      const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
      const bundle = bundleFor(session.metadata?.["priceId"] ?? "");
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      if (!paid || !bundle) {
        const { data: balanceRow } = await supabaseAdmin
          .from("token_balances")
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

      // Single atomic step: the ledger insert (unique on the Stripe session id)
      // and the balance increment happen in one transaction, so a refresh,
      // replay, or two concurrent calls can never credit the same session twice.
      const { data: credit, error: creditError } = await supabaseAdmin
        .rpc("credit_token_purchase", {
          _user_id: context.userId,
          _session_id: session.id,
          _price_id: bundle.priceId,
          _tokens: bundle.tokens,
          // The SQL function accepts NULL for these optional Stripe fields.
          _amount_total: (session.amount_total ?? null) as number,
          _currency: (session.currency ?? null) as string,
        })
        .maybeSingle();

      if (creditError || !credit) {
        console.error("Token crediting failed:", creditError?.message);
        return { ok: false, error: "Payment received, but crediting failed. Contact support." };
      }

      if (!credit.already_credited) {
        const credited = credit.credited ?? bundle.tokens;
        const balance = credit.balance ?? 0;
        const { notifyUser } = await import("./notifications.server");
        await notifyUser({
          userId: context.userId,
          kind: "token_credit",
          title: `${credited} Hybrid Tokens added`,
          body: `Your purchase is complete. ${credited} Hybrid Token${credited === 1 ? " was" : "s were"} credited to your account. New balance: ${balance}.`,
          reference: session.id,
          emailless: true,
        });
        const { sendTokenPurchaseReceipt } = await import("./resend.server");
        await sendTokenPurchaseReceipt({
          userId: context.userId,
          amount: credited,
          balance,
          tokenKind: "hybrid",
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
