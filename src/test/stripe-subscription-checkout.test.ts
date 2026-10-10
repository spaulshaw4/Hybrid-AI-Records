import { afterEach, describe, expect, it, vi } from "vitest";

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

type Profile = {
  user_id: string;
  d_tokens: number;
  subscription_tier: string;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

const {
  createMock,
  ctorArgs,
  constructEventMock,
  resolveStudioSessionMock,
  profiles,
  balances,
  grants,
  grantCalls,
  creditCalls,
  profileUpdates,
  events,
} = vi.hoisted(() => ({
  createMock: vi.fn(),
  ctorArgs: [] as unknown[],
  constructEventMock: vi.fn(),
  resolveStudioSessionMock: vi.fn(),
  profiles: new Map<string, Profile>(),
  balances: new Map<string, number>(),
  grants: new Set<string>(),
  grantCalls: [] as Array<Record<string, unknown>>,
  creditCalls: [] as Array<Record<string, unknown>>,
  profileUpdates: [] as Array<{ column: string; value: string; patch: Record<string, unknown> }>,
  events: new Set<string>(),
}));

vi.mock("stripe", () => {
  class StripeMock {
    checkout = { sessions: { create: (...args: unknown[]) => createMock(...args) } };
    static webhooks = { constructEvent: (...args: unknown[]) => constructEventMock(...args) };
    constructor(key: string, opts: unknown) {
      ctorArgs.push([key, opts]);
    }
  }
  return { default: StripeMock };
});

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return {
          update(patch: Record<string, unknown>) {
            return {
              eq(column: string, value: string) {
                return {
                  select: async () => {
                    const matched: Profile[] = [];
                    for (const profile of profiles.values()) {
                      if ((profile as Record<string, unknown>)[column] === value) {
                        Object.assign(profile, patch);
                        matched.push(profile);
                      }
                    }
                    profileUpdates.push({ column, value, patch });
                    return { data: matched, error: null };
                  },
                };
              },
            };
          },
          select() {
            return {
              eq(column: string, value: string) {
                return {
                  async maybeSingle() {
                    for (const profile of profiles.values()) {
                      if ((profile as Record<string, unknown>)[column] === value) {
                        return { data: profile, error: null };
                      }
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === "stripe_webhook_events") {
        return {
          select: () => ({
            eq: (_column: string, id: string) => ({
              maybeSingle: async () => ({
                data: events.has(id) ? { event_id: id } : null,
                error: null,
              }),
            }),
          }),
          insert: async (row: { event_id: string }) => {
            if (events.has(row.event_id)) return { error: { code: "23505", message: "duplicate" } };
            events.add(row.event_id);
            return { error: null };
          },
        };
      }
      return {
        upsert: async () => ({ error: { message: `unexpected table ${table}` } }),
        insert: async () => ({ error: { message: `unexpected table ${table}` } }),
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      if (fn === "credit_token_purchase") {
        creditCalls.push(args);
        return { data: [{ credited: args._tokens, balance: args._tokens, already_credited: false }], error: null };
      }
      if (fn !== "apply_subscription_grant") {
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      }
      grantCalls.push(args);
      const key = String(args._grant_key);
      const userId = String(args._user_id);
      if (grants.has(key)) {
        return {
          data: [{
            applied: false,
            d_tokens: profiles.get(userId)?.d_tokens ?? 0,
            hybrid_balance: balances.get(userId) ?? 0,
          }],
          error: null,
        };
      }
      grants.add(key);
      const prevD = profiles.get(userId)?.d_tokens ?? 0;
      const prevH = balances.get(userId) ?? 0;
      const nextD = args._mode === "set" ? Number(args._d_tokens) : prevD + Number(args._d_tokens);
      const nextH = args._mode === "set" ? Number(args._hybrid_tokens) : prevH + Number(args._hybrid_tokens);
      const existing = profiles.get(userId);
      profiles.set(userId, {
        user_id: userId,
        d_tokens: nextD,
        subscription_tier: String(args._tier),
        subscription_status: "active",
        stripe_customer_id: String(args._stripe_customer_id || existing?.stripe_customer_id || "") || null,
        stripe_subscription_id: String(args._stripe_subscription_id || existing?.stripe_subscription_id || "") || null,
      });
      balances.set(userId, nextH);
      return { data: [{ applied: true, d_tokens: nextD, hybrid_balance: nextH }], error: null };
    },
  }),
}));

import { POST as createCheckout } from "@/app/api/stripe/create-checkout/route";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const ENV_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO",
  "STRIPE_PRICE_LABEL",
  "STRIPE_WEBHOOK_SECRET",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
  (typeof ENV_KEYS)[number],
  string | undefined
>;

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function resetStores() {
  createMock.mockReset();
  constructEventMock.mockReset();
  resolveStudioSessionMock.mockReset();
  ctorArgs.length = 0;
  profiles.clear();
  balances.clear();
  grants.clear();
  grantCalls.length = 0;
  creditCalls.length = 0;
  profileUpdates.length = 0;
  events.clear();
}

function seed(hybrid: number, dTokens: number, tier = "free", status: string | null = null) {
  balances.set(LEDGER_USER, hybrid);
  profiles.set(LEDGER_USER, {
    user_id: LEDGER_USER,
    d_tokens: dTokens,
    subscription_tier: tier,
    subscription_status: status,
    stripe_customer_id: "cus_test",
    stripe_subscription_id: "sub_test",
  });
}

function checkoutRequest(body: unknown, origin = "http://127.0.0.1:8080"): Request {
  return new Request("http://127.0.0.1:8080/api/stripe/create-checkout", {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer a.b.c" },
    body: JSON.stringify(body),
  });
}

function webhookRequest(body = "{}"): Request {
  return new Request("http://127.0.0.1:8080/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test", "content-type": "application/json" },
    body,
  });
}

describe("POST /api/stripe/create-checkout", () => {
  afterEach(() => {
    resetStores();
    restoreEnv();
  });

  function signedIn() {
    process.env.STRIPE_SECRET_KEY = "sk_test_subscription";
    process.env.STRIPE_PRICE_STARTER = "price_starter_test";
    process.env.STRIPE_PRICE_PRO = "price_pro_test";
    process.env.STRIPE_PRICE_LABEL = "price_label_test";
    resolveStudioSessionMock.mockResolvedValue({
      userId: LEDGER_USER,
      accessToken: "a.b.c",
      supabase: {
        auth: {
          getUser: async () => ({ data: { user: { id: LEDGER_USER, email: "artist@example.com" } }, error: null }),
        },
      },
    });
    createMock.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_sub" });
  }

  it("returns 401 without a session and does not call Stripe", async () => {
    signedIn();
    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));

    const res = await createCheckout(checkoutRequest({ tier: "starter_999", userId: OTHER_USER }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Please sign in to subscribe." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 400 for an unknown tier and does not call Stripe", async () => {
    signedIn();

    const res = await createCheckout(
      checkoutRequest({ tier: "d5", userId: OTHER_USER, priceId: "price_from_browser" }),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Unknown subscription tier." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 503 when the price env is missing and does not call Stripe", async () => {
    signedIn();
    delete process.env.STRIPE_PRICE_STARTER;
    delete process.env.STRIPE_PRICE_PRO;
    delete process.env.STRIPE_PRICE_LABEL;

    const res = await createCheckout(checkoutRequest({ tier: "pro_1999", priceId: "price_from_browser" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Subscriptions are not configured." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("creates a subscription session from the session user and mapped price", async () => {
    signedIn();

    const res = await createCheckout(
      checkoutRequest({
        tier: "starter_999",
        userId: OTHER_USER,
        priceId: "price_from_browser",
        email: "browser@example.com",
        client_reference_id: OTHER_USER,
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_sub" });
    expect(ctorArgs).toEqual([["sk_test_subscription", { apiVersion: "2026-03-25.dahlia" }]]);

    const params = createMock.mock.calls[0][0] as {
      mode: string;
      client_reference_id: string;
      customer_email?: string;
      customer?: string;
      metadata: { userId: string; tier: string };
      subscription_data: { metadata: { userId: string; tier: string } };
      success_url: string;
      cancel_url: string;
      line_items: Array<{ price: string; quantity: number }>;
    };
    expect(params.mode).toBe("subscription");
    expect(params.client_reference_id).toBe(LEDGER_USER);
    expect(params.customer_email).toBe("artist@example.com");
    expect(params.customer).toBeUndefined();
    expect(params.metadata).toEqual({ userId: LEDGER_USER, tier: "starter_999" });
    expect(params.subscription_data.metadata).toEqual({ userId: LEDGER_USER, tier: "starter_999" });
    expect(params.line_items).toEqual([{ price: "price_starter_test", quantity: 1 }]);
    expect(params.success_url).toBe(
      "http://127.0.0.1:8080/portal?payment=success&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe("http://127.0.0.1:8080/portal?payment=cancelled");
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain(OTHER_USER);
    expect(serialized).not.toContain("price_from_browser");
    expect(serialized).not.toContain("browser@example.com");
  });
});

describe("POST /api/stripe/webhook subscription grants", () => {
  afterEach(() => {
    resetStores();
    restoreEnv();
  });

  function ready() {
    process.env.STRIPE_SECRET_KEY = "sk_test_subscription";
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
  }

  it("rejects a bad signature", async () => {
    ready();
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const res = await stripeWebhook(webhookRequest("{}"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Webhook Error: No signatures found matching the expected signature for payload",
    });
    expect(grantCalls).toEqual([]);
    expect(creditCalls).toEqual([]);
    expect(profileUpdates).toEqual([]);
  });

  it("sets subscription fields and replaces balances once for checkout.session.completed", async () => {
    ready();
    seed(7, 3);
    constructEventMock.mockReturnValue({
      id: "evt_sub_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_1",
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_test",
          subscription: "sub_test",
          client_reference_id: OTHER_USER,
          metadata: { userId: LEDGER_USER, tier: "starter_999", tokens: "999" },
        },
      },
    });

    const first = await stripeWebhook(webhookRequest());
    constructEventMock.mockReturnValue({
      id: "evt_sub_1_retry",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_sub_1",
          mode: "subscription",
          payment_status: "paid",
          customer: "cus_test",
          subscription: "sub_test",
          client_reference_id: OTHER_USER,
          metadata: { userId: LEDGER_USER, tier: "starter_999" },
        },
      },
    });
    const second = await stripeWebhook(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true });
    await expect(second.json()).resolves.toEqual({ received: true });
    expect(grantCalls).toHaveLength(2);
    expect(grantCalls[0]).toMatchObject({
      _user_id: LEDGER_USER,
      _grant_key: "checkout:cs_sub_1",
      _tier: "starter_999",
      _kind: "initial",
      _mode: "set",
      _d_tokens: 5,
      _hybrid_tokens: 20,
      _stripe_customer_id: "cus_test",
      _stripe_subscription_id: "sub_test",
    });
    expect(grantCalls[1]).toMatchObject({ _grant_key: "checkout:cs_sub_1", _mode: "set" });
    expect(balances.get(LEDGER_USER)).toBe(20);
    expect(profiles.get(LEDGER_USER)).toMatchObject({
      d_tokens: 5,
      subscription_tier: "starter_999",
      subscription_status: "active",
      stripe_customer_id: "cus_test",
      stripe_subscription_id: "sub_test",
    });
    expect(creditCalls).toEqual([]);
    expect(grants.size).toBe(1);
  });

  it("adds the tier allowance for invoice.paid subscription_cycle and ignores a repeat invoice", async () => {
    ready();
    seed(20, 5, "starter_999", "active");
    const invoice = {
      id: "in_cycle_1",
      billing_reason: "subscription_cycle",
      customer: "cus_test",
      subscription: "sub_test",
      metadata: { userId: LEDGER_USER, tier: "pro_1999" },
    };
    constructEventMock.mockReturnValue({ id: "evt_inv_1", type: "invoice.paid", data: { object: invoice } });
    const first = await stripeWebhook(webhookRequest());
    constructEventMock.mockReturnValue({ id: "evt_inv_1_retry", type: "invoice.paid", data: { object: invoice } });
    const second = await stripeWebhook(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(grantCalls.map((call) => call._mode)).toEqual(["add", "add"]);
    expect(grantCalls[0]).toMatchObject({
      _user_id: LEDGER_USER,
      _grant_key: "invoice:in_cycle_1",
      _tier: "pro_1999",
      _kind: "cycle",
      _d_tokens: 12,
      _hybrid_tokens: 50,
    });
    expect(balances.get(LEDGER_USER)).toBe(70);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(17);
    expect(profiles.get(LEDGER_USER)?.subscription_tier).toBe("pro_1999");
    expect(grants.size).toBe(1);
  });

  it("does not increment invoice.paid when billing_reason is not subscription_cycle", async () => {
    ready();
    seed(20, 5, "pro_1999", "active");
    constructEventMock.mockReturnValue({
      id: "evt_inv_create",
      type: "invoice.paid",
      data: {
        object: {
          id: "in_create_1",
          billing_reason: "subscription_create",
          customer: "cus_test",
          subscription: "sub_test",
          metadata: { userId: LEDGER_USER, tier: "pro_1999" },
        },
      },
    });

    const res = await stripeWebhook(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(grantCalls).toEqual([]);
    expect(balances.get(LEDGER_USER)).toBe(20);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(5);
    expect(profiles.get(LEDGER_USER)?.subscription_tier).toBe("pro_1999");
  });

  it("marks the plan canceled and free without zeroing balances", async () => {
    ready();
    seed(50, 12, "pro_1999", "active");
    constructEventMock.mockReturnValue({
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_test",
          customer: "cus_test",
          metadata: { userId: LEDGER_USER, tier: "pro_1999" },
        },
      },
    });

    const res = await stripeWebhook(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(profileUpdates).toEqual([
      {
        column: "user_id",
        value: LEDGER_USER,
        patch: { subscription_status: "canceled", subscription_tier: "free" },
      },
    ]);
    expect(profiles.get(LEDGER_USER)).toMatchObject({
      subscription_status: "canceled",
      subscription_tier: "free",
      d_tokens: 12,
    });
    expect(balances.get(LEDGER_USER)).toBe(50);
    expect(grantCalls).toEqual([]);
  });

  it("ignores a one-time pack checkout and leaves the subscription grant unused", async () => {
    ready();
    seed(7, 3);
    constructEventMock.mockReturnValue({
      id: "evt_pack_d5",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_pack_d5",
          mode: "payment",
          payment_status: "paid",
          amount_total: 500,
          currency: "usd",
          metadata: { tokens: "5", userId: LEDGER_USER, pack: "d5", tier: "starter_999" },
        },
      },
    });

    const res = await stripeWebhook(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(grantCalls).toEqual([]);
    expect(creditCalls).toEqual([
      expect.objectContaining({
        _user_id: LEDGER_USER,
        _session_id: "cs_pack_d5",
        _tokens: 5,
      }),
    ]);
    expect(balances.get(LEDGER_USER)).toBe(7);
    expect(profiles.get(LEDGER_USER)).toMatchObject({
      d_tokens: 3,
      subscription_tier: "free",
      subscription_status: null,
    });
  });
});
