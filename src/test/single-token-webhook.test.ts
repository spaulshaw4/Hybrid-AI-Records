import { afterEach, describe, expect, it, vi } from "vitest";

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";

type Profile = {
  user_id: string;
  d_tokens: number;
  subscription_tier: string;
  subscription_status: string | null;
};

const {
  constructEventMock,
  recordPendingPayout,
  sendPayoutAlert,
  hybrid,
  profiles,
  artistBalances,
  artistLedger,
  events,
  rpcCalls,
  profileWrites,
  payoutCredits,
} = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  recordPendingPayout: vi.fn(),
  sendPayoutAlert: vi.fn(),
  hybrid: new Map<string, number>(),
  profiles: new Map<string, Profile>(),
  artistBalances: new Map<string, number>(),
  artistLedger: [] as Array<{ userId: string; delta: number; reference: string }>,
  events: new Set<string>(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  profileWrites: [] as Array<{ userId: string; patch: Record<string, unknown> }>,
  payoutCredits: new Set<string>(),
}));

vi.mock("stripe", () => {
  class StripeMock {
    constructor(_key: string, _opts: unknown) {}
    static webhooks = { constructEvent: (...args: unknown[]) => constructEventMock(...args) };
  }
  return { default: StripeMock };
});

vi.mock("@/lib/pending-payouts.server", () => ({
  recordPendingPayout: (...args: unknown[]) => recordPendingPayout(...args),
}));

vi.mock("@/lib/payout-alert.server", () => ({
  sendPayoutAlert: (...args: unknown[]) => sendPayoutAlert(...args),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
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
          delete: () => ({
            eq: async (_column: string, id: string) => {
              events.delete(id);
              return { error: null };
            },
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: (_column: string, userId: string) => ({
              maybeSingle: async () => ({ data: profiles.get(userId) ?? null, error: null }),
            }),
          }),
          update(patch: Record<string, unknown>) {
            return {
              eq: async (_column: string, userId: string) => {
                const row = profiles.get(userId);
                if (row) Object.assign(row, patch);
                profileWrites.push({ userId, patch });
                return { error: null };
              },
            };
          },
          insert: async (row: { user_id: string; d_tokens: number }) => {
            profiles.set(row.user_id, {
              user_id: row.user_id,
              d_tokens: row.d_tokens,
              subscription_tier: "free",
              subscription_status: null,
            });
            return { error: null };
          },
        };
      }
      return {
        insert: async () => ({ error: { message: `unexpected table ${table}` } }),
        upsert: async () => ({ error: { message: `unexpected table ${table}` } }),
      };
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      const userId = String(args._user_id);
      if (fn === "credit_token_purchase") {
        const next = (hybrid.get(userId) ?? 0) + Number(args._tokens);
        hybrid.set(userId, next);
        return { data: [{ credited: args._tokens, balance: next, already_credited: false }], error: null };
      }
      if (fn === "credit_artist_token_purchase") {
        const next = (artistBalances.get(userId) ?? 0) + Number(args._tokens);
        artistBalances.set(userId, next);
        artistLedger.push({ userId, delta: Number(args._tokens), reference: String(args._session_id) });
        return { data: [{ credited: args._tokens, balance: next, already_credited: false }], error: null };
      }
      return { data: null, error: { message: `unexpected rpc ${fn}` } };
    },
  }),
}));

import { POST } from "@/app/api/stripe/webhook/route";

function webhookRequest(): Request {
  return new Request("http://127.0.0.1:8080/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test", "content-type": "application/json" },
    body: "{}",
  });
}

function paymentSession(args: {
  id: string;
  eventId: string;
  metadata: Record<string, string>;
  clientReferenceId?: string;
  mode?: string;
}) {
  return {
    id: args.eventId,
    type: "checkout.session.completed",
    data: {
      object: {
        id: args.id,
        mode: args.mode ?? "payment",
        payment_status: "paid",
        amount_total: 100,
        currency: "usd",
        client_reference_id: args.clientReferenceId ?? LEDGER_USER,
        metadata: args.metadata,
      },
    },
  };
}

describe("single-token and catalog artist webhook credits", () => {
  afterEach(() => {
    constructEventMock.mockReset();
    recordPendingPayout.mockReset();
    sendPayoutAlert.mockReset();
    hybrid.clear();
    profiles.clear();
    artistBalances.clear();
    artistLedger.length = 0;
    events.clear();
    rpcCalls.length = 0;
    profileWrites.length = 0;
    payoutCredits.clear();
  });

  function ready() {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_SECRET_KEY = "sk_test_webhook";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    hybrid.set(LEDGER_USER, 10);
    profiles.set(LEDGER_USER, {
      user_id: LEDGER_USER,
      d_tokens: 4,
      subscription_tier: "free",
      subscription_status: null,
    });
    artistBalances.set(LEDGER_USER, 7);
    sendPayoutAlert.mockResolvedValue({ ok: true });
    recordPendingPayout.mockImplementation(async (payload: { data: { transaction_id: string } }) => {
      const id = payload.data.transaction_id;
      if (payoutCredits.has(id)) return { inserted: false };
      payoutCredits.add(id);
      return { inserted: true };
    });
  }

  it("credits an h_token checkout onto token_balances.balance only, once per session", async () => {
    ready();
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_h_1",
        eventId: "evt_h_1",
        metadata: { tokenType: "h_token", quantity: "1", userId: LEDGER_USER },
      }),
    );

    const first = await POST(webhookRequest());
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_h_1",
        eventId: "evt_h_2",
        metadata: { tokenType: "h_token", quantity: "1", userId: LEDGER_USER },
      }),
    );
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rpcCalls).toEqual([
      expect.objectContaining({
        fn: "credit_token_purchase",
        args: expect.objectContaining({
          _user_id: LEDGER_USER,
          _session_id: "cs_h_1",
          _tokens: 1,
          _price_id: "single_h_token",
        }),
      }),
    ]);
    expect(hybrid.get(LEDGER_USER)).toBe(11);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(4);
    expect(profiles.get(LEDGER_USER)?.subscription_tier).toBe("free");
    expect(artistBalances.get(LEDGER_USER)).toBe(7);
    expect(artistLedger).toEqual([]);
    expect(profileWrites).toEqual([]);
    expect(payoutCredits.size).toBe(0);
  });

  it("credits a d_token checkout onto profiles.d_tokens only, once per session", async () => {
    ready();
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_d_1",
        eventId: "evt_d_1",
        metadata: { tokenType: "d_token", quantity: "1", userId: LEDGER_USER },
      }),
    );

    const first = await POST(webhookRequest());
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_d_1",
        eventId: "evt_d_2",
        metadata: { tokenType: "d_token", quantity: "1", userId: LEDGER_USER },
      }),
    );
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(5);
    expect(profiles.get(LEDGER_USER)?.subscription_tier).toBe("free");
    expect(hybrid.get(LEDGER_USER)).toBe(10);
    expect(artistBalances.get(LEDGER_USER)).toBe(7);
    expect(rpcCalls).toEqual([]);
    expect(profileWrites).toEqual([{ userId: LEDGER_USER, patch: { d_tokens: 5 } }]);
    expect(payoutCredits.size).toBe(0);
  });

  it("credits a plans artist_token quantity onto the buyer artist ledger only", async () => {
    ready();
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_artist_qty",
        eventId: "evt_artist_qty_1",
        metadata: { tokenType: "artist_token", quantity: "4", userId: LEDGER_USER },
      }),
    );

    const first = await POST(webhookRequest());
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_artist_qty",
        eventId: "evt_artist_qty_2",
        metadata: { tokenType: "artist_token", quantity: "4", userId: LEDGER_USER },
      }),
    );
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(rpcCalls.map((call) => call.fn)).toEqual(["credit_artist_token_purchase"]);
    expect(rpcCalls[0]?.args).toMatchObject({
      _user_id: LEDGER_USER,
      _session_id: "cs_artist_qty",
      _tokens: 4,
    });
    expect(artistBalances.get(LEDGER_USER)).toBe(11);
    expect(artistLedger).toEqual([{ userId: LEDGER_USER, delta: 4, reference: "cs_artist_qty" }]);
    expect(hybrid.get(LEDGER_USER)).toBe(10);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(4);
    expect(profiles.get(LEDGER_USER)?.subscription_tier).toBe("free");
    expect(profileWrites).toEqual([]);
  });

  it("does not credit a single-token pack when the user id is not a uuid or the ids disagree", async () => {
    ready();
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_bad_user",
        eventId: "evt_bad_user",
        clientReferenceId: "not-a-uuid",
        metadata: { tokenType: "h_token", quantity: "1", userId: "not-a-uuid" },
      }),
    );
    const bad = await POST(webhookRequest());

    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_mismatch",
        eventId: "evt_mismatch",
        clientReferenceId: LEDGER_USER,
        metadata: { tokenType: "h_token", quantity: "1", userId: OTHER_USER },
      }),
    );
    const mismatch = await POST(webhookRequest());

    expect(bad.status).toBe(200);
    expect(mismatch.status).toBe(200);
    expect(rpcCalls).toEqual([]);
    expect(hybrid.get(LEDGER_USER)).toBe(10);
    expect(profiles.get(LEDGER_USER)?.d_tokens).toBe(4);
  });

  it("credits a catalog artist_token onto the artist ledger once and does not set a subscription tier", async () => {
    ready();
    const metadata = {
      type: "artist_token",
      artistId: "stephen-p-shaw",
      trackId: "vbf-africa",
      buyerId: LEDGER_USER,
    };
    constructEventMock.mockReturnValue(
      paymentSession({ id: "cs_catalog_1", eventId: "evt_catalog_1", metadata }),
    );

    const first = await POST(webhookRequest());
    constructEventMock.mockReturnValue(
      paymentSession({ id: "cs_catalog_1", eventId: "evt_catalog_2", metadata }),
    );
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(payoutCredits.size).toBe(1);
    expect(recordPendingPayout).toHaveBeenCalledTimes(2);
    expect(recordPendingPayout.mock.calls[0]?.[0]).toMatchObject({
      data: {
        token_amount: 1,
        artist_name: "stephen-p-shaw",
        artist_payout_target: "stephen-p-shaw",
        song_title: "vbf-africa",
        transaction_id: "cs_catalog_1",
        stripe_session_id: "cs_catalog_1",
      },
    });
    expect(sendPayoutAlert).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toEqual([]);
    expect(profileWrites).toEqual([]);
    expect(hybrid.get(LEDGER_USER)).toBe(10);
    expect(profiles.get(LEDGER_USER)).toMatchObject({
      d_tokens: 4,
      subscription_tier: "free",
      subscription_status: null,
    });
    expect(artistBalances.get(LEDGER_USER)).toBe(7);
  });

  it("does not treat a subscription checkout as a single-token or catalog artist pack", async () => {
    ready();
    constructEventMock.mockReturnValue(
      paymentSession({
        id: "cs_sub_single",
        eventId: "evt_sub_single",
        mode: "subscription",
        metadata: {
          type: "artist_token",
          tokenType: "h_token",
          quantity: "1",
          userId: LEDGER_USER,
          artistId: "stephen-p-shaw",
          trackId: "vbf-africa",
          buyerId: LEDGER_USER,
        },
      }),
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([]);
    expect(recordPendingPayout).not.toHaveBeenCalled();
    expect(profileWrites).toEqual([]);
    expect(hybrid.get(LEDGER_USER)).toBe(10);
    expect(profiles.get(LEDGER_USER)).toMatchObject({
      d_tokens: 4,
      subscription_tier: "free",
      subscription_status: null,
    });
  });
});
