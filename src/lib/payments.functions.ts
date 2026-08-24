import { createServerFn } from "@tanstack/react-start";
import { type StripeEnv, createStripeClient, getStripeErrorMessage } from "@/lib/stripe.server";
import {
  DEFAULT_CURRENCY,
  PACKAGE_PRICES,
  amountFor,
  basePriceFor,

  surchargeAmountFor,
  surchargePercent,
  isCurrencyCode,
  type CurrencyCode,
} from "@/lib/pricing";
import { verifyCheckoutAmount, type AmountMismatch } from "@/lib/checkout-verification";
import { classifyOutcome, outcomeMessage, type PaymentOutcome } from "@/lib/payment-outcome";

export type { AmountMismatch };


type CheckoutSessionResult =
  | { clientSecret: string }
  | { error: string; code?: "blocked_return_url"; safeOrigin?: string };

async function resolveOrCreateCustomer(
  stripe: ReturnType<typeof createStripeClient>,
  options: { email?: string; userId?: string },
): Promise<string> {
  if (options.userId && !/^[a-zA-Z0-9_-]+$/.test(options.userId)) {
    throw new Error("Invalid userId");
  }
  if (options.userId) {
    const found = await stripe.customers.search({
      query: `metadata['userId']:'${options.userId}'`,
      limit: 1,
    });
    if (found.data.length) return found.data[0].id;
  }
  if (options.email) {
    const existing = await stripe.customers.list({ email: options.email, limit: 1 });
    if (existing.data.length) {
      const customer = existing.data[0];
      if (options.userId && customer.metadata?.userId !== options.userId) {
        await stripe.customers.update(customer.id, {
          metadata: { ...customer.metadata, userId: options.userId },
        });
      }
      return customer.id;
    }
  }
  const created = await stripe.customers.create({
    ...(options.email && { email: options.email }),
    ...(options.userId && { metadata: { userId: options.userId } }),
  });
  return created.id;
}

export const createCheckoutSession = createServerFn({ method: "POST" })
  .validator((data: {
    priceId: string;
    quantity?: number;
    customerEmail?: string;
    userId?: string;
    returnUrl: string;
    environment: StripeEnv;
    /** Display/settlement currency chosen by the buyer. Defaults to USD. */
    currency?: CurrencyCode;
    /** Reference code of the track submission this payment pays for. */
    trackReference?: string;
  }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(data.priceId)) throw new Error("Invalid priceId");
    if (data.trackReference && !/^HAR-[A-Z0-9]{4,12}$/.test(data.trackReference)) {
      throw new Error("Invalid trackReference");
    }
    if (data.currency && !isCurrencyCode(data.currency)) throw new Error("Invalid currency");
    return data;
  })
  .handler(async ({ data }): Promise<CheckoutSessionResult> => {
    try {
      // Pull the admin-configured surcharge rates before any amount is computed.
      await (await import("@/lib/pricing-settings.server")).readSurchargeSettings();
      // Live daily FX rates drive the non-USD base prices.
      await (await import("@/lib/fx-rates.server")).readFxRates();
      const { allowedSiteUrl, defaultSiteOrigin, auditRedirect } = await import(
        "@/lib/site-origin.server"
      );
      const returnUrl = allowedSiteUrl(data.returnUrl);
      auditRedirect({
        surface: "stripe_return_url",
        candidate: data.returnUrl,
        resolved: returnUrl ?? defaultSiteOrigin(),
        allowed: Boolean(returnUrl),
        context: { priceId: data.priceId, environment: data.environment, hasUser: Boolean(data.userId) },
      });
      if (!returnUrl) {
        // The page asked Stripe to send the customer somewhere we don't own.
        // Refuse, and tell the UI where the customer can safely continue.
        return {
          error:
            "For your security we can't send you back to that address after payment. Continue on the official Hybrid AI Records site and your order will go through.",
          code: "blocked_return_url" as const,
          safeOrigin: defaultSiteOrigin(),
        };
      }


      const stripe = createStripeClient(data.environment);
      const currency: CurrencyCode = data.currency ?? DEFAULT_CURRENCY;
      const localPrice = PACKAGE_PRICES[data.priceId];

      // USD uses the catalog price in Stripe. EUR/NGN are published local
      // prices: the amount always comes from the server-side table, never
      // from the browser.
      const useLocalPrice = currency !== DEFAULT_CURRENCY;
      if (useLocalPrice && !localPrice) {
        return {
          error: `This package isn't available in ${currency.toUpperCase()} yet. Switch to USD to continue.`,
        };
      }

      type LineItem = {
        price?: string;
        price_data?: {
          currency: string;
          product_data: { name: string };
          unit_amount: number;
        };
        quantity: number;
      };
      const lineItems: LineItem[] = [];
      let isRecurring = false;
      let productDescription: string | undefined;

      if (useLocalPrice) {
        productDescription = localPrice.name;
        const quantity = data.quantity || 1;
        // The published local price and the cross-border processing fee are
        // billed as two separate line items so the surcharge is itemized on
        // the checkout page, the receipt and the invoice.
        lineItems.push({
          price_data: {
            currency,
            product_data: { name: localPrice.name },
            unit_amount: basePriceFor(data.priceId, currency) ?? localPrice.amounts[currency],
          },
          quantity,
        });

        const surcharge = surchargeAmountFor(data.priceId, currency) ?? 0;
        if (surcharge > 0) {
          lineItems.push({
            price_data: {
              currency,
              product_data: {
                name: `International processing fee (${surchargePercent(currency)}%)`,
              },
              unit_amount: surcharge,
            },
            quantity,
          });
        }
      } else {
        const prices = await stripe.prices.list({ lookup_keys: [data.priceId] });
        if (!prices.data.length) throw new Error("Price not found");
        const stripePrice = prices.data[0];
        isRecurring = stripePrice.type === "recurring";
        if (!isRecurring) {
          const productId = typeof stripePrice.product === "string"
            ? stripePrice.product
            : stripePrice.product.id;
          const product = await stripe.products.retrieve(productId);
          productDescription = product.name;
        }
        lineItems.push({ price: stripePrice.id, quantity: data.quantity || 1 });
      }

      const customerId = (data.customerEmail || data.userId)
        ? await resolveOrCreateCustomer(stripe, {
            email: data.customerEmail,
            userId: data.userId,
          })
        : undefined;

      const session = await stripe.checkout.sessions.create({
        line_items: lineItems,
        mode: isRecurring ? "subscription" : "payment",
        ui_mode: "embedded_page",
        return_url: returnUrl,
        ...(customerId && { customer: customerId }),
        ...(!isRecurring && { payment_intent_data: { description: productDescription } }),
        managed_payments: { enabled: true },
        metadata: {
          currency,
          priceId: data.priceId,
          ...(data.trackReference && { trackReference: data.trackReference }),
          ...(data.userId && { userId: data.userId }),
        },
        ...(data.userId && isRecurring && {
          subscription_data: { metadata: { userId: data.userId } },
        }),
      } as import("stripe").Stripe.Checkout.SessionCreateParams);

      return { clientSecret: session.client_secret ?? "" };
    } catch (error) {
      return { error: getStripeErrorMessage(error) };
    }
  });

type ConfirmResult =
  | {
      ok: true;
      paid: boolean;
      /** How this specific checkout attempt ended. */
      outcome: PaymentOutcome;
      /** Buyer-facing sentence when the attempt didn't pay. */
      outcomeMessage: string | null;
      /** True when this session was already confirmed on an earlier visit. */
      alreadyConfirmed: boolean;
      /** Set when a different session already paid this submission. */
      duplicateOfSessionId: string | null;
      reference: string | null;
      amountLabel: string | null;
      email: string | null;
      mismatch: AmountMismatch | null;
    }
  | { ok: false; error: string };

/**
 * Reads a Checkout Session and, when it belongs to a track submission and the
 * money actually landed, flips that submission to "paid". Idempotent: replays,
 * failed retries, expired sessions and duplicate sessions can never apply a
 * second status change.
 */
export const confirmCheckoutOrder = createServerFn({ method: "POST" })
  .validator((data: { sessionId: string; environment: StripeEnv }) => {
    if (!/^cs_[A-Za-z0-9_]+$/.test(data.sessionId)) throw new Error("Invalid sessionId");
    return data;
  })
  .handler(async ({ data }): Promise<ConfirmResult> => {
    try {
      // Verification compares against the same live rates checkout used.
      await (await import("@/lib/pricing-settings.server")).readSurchargeSettings();
      // Live daily FX rates drive the non-USD base prices.
      await (await import("@/lib/fx-rates.server")).readFxRates();
      const stripe = createStripeClient(data.environment);
      const session = await stripe.checkout.sessions.retrieve(data.sessionId);
      const outcome = classifyOutcome({
        status: session.status ?? null,
        paymentStatus: session.payment_status ?? null,
      });
      const paid = outcome === "paid";
      const reference = session.metadata?.["trackReference"] ?? null;

      let referenceFound: boolean | null = null;
      if (reference) {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        // The reference must belong to a real submission before we call it verified.
        const { data: existing, error: lookupError } = await supabaseAdmin
          .from("track_requests")
          .select("reference_code")
          .eq("reference_code", reference)
          .maybeSingle();
        if (lookupError) console.error("Order lookup failed:", lookupError.message);
        else referenceFound = Boolean(existing);
      }

      // ---- Verify what Stripe actually charged against our own price table.
      // Only meaningful for a paid attempt; an abandoned session has no total.
      const verdict = verifyCheckoutAmount({
        metaPriceId: session.metadata?.["priceId"] ?? null,
        metaCurrency: session.metadata?.["currency"] ?? null,
        chargedCurrency: session.currency ?? null,
        amountTotal: session.amount_total ?? null,
        reference,
        referenceFound,
        sessionId: data.sessionId,
        paymentIntentId:
          typeof session.payment_intent === "string"
            ? session.payment_intent
            : (session.payment_intent?.id ?? null),
      });
      const issues = paid ? verdict.issues : [];
      const mismatch = paid ? verdict.mismatch : null;

      const { applyCheckoutOutcome } = await import("@/lib/payment-confirm.server");
      const applied = await applyCheckoutOutcome({
        sessionId: data.sessionId,
        reference,
        referenceFound,
        outcome,
        amountLabel: verdict.chargedLabel,
        issues,
        currency: session.currency ?? null,
      });

      const email =
        session.customer_details?.email ?? session.customer_email ?? null;

      return {
        ok: true,
        // A replay of an already-settled order still reads as paid to the buyer.
        paid: paid || applied.settled,
        outcome,
        outcomeMessage: paid ? null : outcomeMessage(outcome),
        alreadyConfirmed: applied.decision === "already_applied",
        duplicateOfSessionId: applied.duplicateOfSessionId,
        reference,
        amountLabel: verdict.chargedLabel ?? applied.storedAmountLabel,
        email,
        mismatch,
      };

    } catch (error) {
      return { ok: false, error: getStripeErrorMessage(error) };
    }
  });

