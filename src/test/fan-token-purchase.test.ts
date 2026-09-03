/**
 * Fan-token purchase: parse token.purchased / Stripe metadata, idempotent
 * Pending Payout insert, and payout alert (mocked — no live Stripe/Resend).
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

import {
  DEFAULT_PAYOUT_ALERT_EMAIL,
  PAYOUT_ALERT_FROM,
  PENDING_PAYOUT_STATUS,
  buildFanTokenCheckoutMetadata,
  buildPayoutAlertText,
  fulfillFanTokenPurchase,
  parseTokenPurchased,
  payoutAlertRecipient,
  payoutAlertSubject,
} from "@/lib/fan-token-purchase";
import { handleStripeWebhook } from "@/lib/stripe-webhook-fulfill.server";

const SAMPLE = {
  event: "token.purchased" as const,
  data: {
    token_amount: 1.0,
    currency: "USD",
    song_title: "Heavy Sky",
    artist_name: "Jester",
    artist_payout_target: "paypal@artistdomain.com",
    buyer_email: "fan@example.com",
    transaction_id: "tx_984729184",
  },
};

const recordPendingPayout = vi.hoisted(() => vi.fn(async () => ({ inserted: true })));
const sendPayoutAlert = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

vi.mock("@/lib/pending-payouts.server", () => ({
  recordPendingPayout,
}));
vi.mock("@/lib/payout-alert.server", () => ({
  sendPayoutAlert,
}));

const originalEnv = {
  PAYOUT_ALERT_EMAIL: process.env.PAYOUT_ALERT_EMAIL,
  ALERT_EMAIL: process.env.ALERT_EMAIL,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
};

afterEach(() => {
  recordPendingPayout.mockClear();
  sendPayoutAlert.mockClear();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("parseTokenPurchased", () => {
  it("parses the canonical token.purchased envelope", () => {
    const parsed = parseTokenPurchased(SAMPLE);
    expect(parsed).toEqual(SAMPLE);
  });

  it("accepts payout_address as an alias of artist_payout_target", () => {
    const parsed = parseTokenPurchased({
      event: "token.purchased",
      data: {
        ...SAMPLE.data,
        artist_payout_target: undefined,
        payout_address: "0xArtistWallet",
      },
    });
    expect(parsed?.data.artist_payout_target).toBe("0xArtistWallet");
  });

  it("extracts routing metadata from checkout.session.completed", () => {
    const parsed = parseTokenPurchased({
      id: "evt_test_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_fan_1",
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 100,
          currency: "usd",
          customer_email: "fan@example.com",
          payment_intent: "pi_test_fan_1",
          metadata: {
            kind: "artist_tokens",
            artist_name: "Jester",
            song_title: "Heavy Sky",
            artist_payout_target: "paypal@artistdomain.com",
            buyer_email: "fan@example.com",
          },
        },
      },
    });
    expect(parsed?.event).toBe("token.purchased");
    expect(parsed?.data).toMatchObject({
      token_amount: 1,
      currency: "USD",
      song_title: "Heavy Sky",
      artist_name: "Jester",
      artist_payout_target: "paypal@artistdomain.com",
      buyer_email: "fan@example.com",
      transaction_id: "pi_test_fan_1",
      stripe_session_id: "cs_test_fan_1",
    });
  });

  it("skips unpaid sessions and non-artist token kinds", () => {
    expect(
      parseTokenPurchased({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_unpaid",
            payment_status: "unpaid",
            metadata: { kind: "artist_tokens", artist_name: "Jester", song_title: "Heavy Sky" },
          },
        },
      }),
    ).toBeNull();
    expect(
      parseTokenPurchased({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_hybrid",
            payment_status: "paid",
            metadata: { kind: "hybrid_tokens", artist_name: "Jester", song_title: "Heavy Sky" },
          },
        },
      }),
    ).toBeNull();
  });
});

describe("checkout metadata + alert copy", () => {
  it("stamps artist, song, payout target, and buyer email onto Stripe metadata", () => {
    expect(
      buildFanTokenCheckoutMetadata({
        artistName: "Jester",
        songTitle: "Heavy Sky",
        artistPayoutTarget: "paypal@artistdomain.com",
        buyerEmail: "fan@example.com",
      }),
    ).toEqual({
      artist_name: "Jester",
      song_title: "Heavy Sky",
      artist_payout_target: "paypal@artistdomain.com",
      payout_address: "paypal@artistdomain.com",
      buyer_email: "fan@example.com",
    });
  });

  it("builds an alert that includes routing fields and 100% payout language", () => {
    const text = buildPayoutAlertText(SAMPLE.data);
    expect(payoutAlertSubject(SAMPLE.data)).toContain("Jester");
    expect(text).toContain("Jester");
    expect(text).toContain("Heavy Sky");
    expect(text).toContain("$1.00");
    expect(text).toContain("paypal@artistdomain.com");
    expect(text).toContain("fan@example.com");
    expect(text).toContain("tx_984729184");
    expect(text).toMatch(/payout is 100% to that address/i);
    expect(text).toContain(PENDING_PAYOUT_STATUS);
    expect(PAYOUT_ALERT_FROM).toBe("Hybrid AI Records <notifications@hybrid-ai-records.com>");
  });

  it("uses PAYOUT_ALERT_EMAIL when set, otherwise Stephen's inbox", () => {
    delete process.env.PAYOUT_ALERT_EMAIL;
    delete process.env.ALERT_EMAIL;
    expect(payoutAlertRecipient()).toBe(DEFAULT_PAYOUT_ALERT_EMAIL);
    process.env.PAYOUT_ALERT_EMAIL = "ops@hybrid-ai-records.com";
    expect(payoutAlertRecipient()).toBe("ops@hybrid-ai-records.com");
  });
});

describe("fulfillFanTokenPurchase", () => {
  it("inserts Pending Payout and invokes the alert once", async () => {
    const record = vi.fn(async () => ({ inserted: true }));
    const sendAlert = vi.fn(async () => ({ ok: true }));
    const first = await fulfillFanTokenPurchase(SAMPLE, { recordPendingPayout: record, sendAlert });
    expect(first).toEqual({ recorded: true, inserted: true, alerted: true });
    expect(record).toHaveBeenCalledOnce();
    expect(sendAlert).toHaveBeenCalledOnce();
    expect(sendAlert.mock.calls[0][0].data.artist_payout_target).toBe("paypal@artistdomain.com");
  });

  it("is idempotent on transaction_id — second insert does not re-alert", async () => {
    let existing = false;
    const record = vi.fn(async () => {
      if (existing) return { inserted: false };
      existing = true;
      return { inserted: true };
    });
    const sendAlert = vi.fn(async () => ({ ok: true }));
    await fulfillFanTokenPurchase(SAMPLE, { recordPendingPayout: record, sendAlert });
    const replay = await fulfillFanTokenPurchase(SAMPLE, { recordPendingPayout: record, sendAlert });
    expect(replay).toEqual({ recorded: true, inserted: false, alerted: false });
    expect(record).toHaveBeenCalledTimes(2);
    expect(sendAlert).toHaveBeenCalledOnce();
  });
});

describe("handleStripeWebhook", () => {
  it("verifies the Stripe signature and records a pending payout + alert", async () => {
    const secret = "whsec_test_fan_token";
    process.env.STRIPE_WEBHOOK_SECRET = secret;
    recordPendingPayout.mockResolvedValue({ inserted: true });
    sendPayoutAlert.mockResolvedValue({ ok: true });

    const event = {
      id: "evt_fan_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_fan_1",
          object: "checkout.session",
          payment_status: "paid",
          amount_total: 100,
          currency: "usd",
          customer_details: { email: "fan@example.com" },
          payment_intent: "pi_test_fan_1",
          metadata: {
            kind: "artist_tokens",
            artist_name: "Jester",
            song_title: "Heavy Sky",
            artist_payout_target: "paypal@artistdomain.com",
          },
        },
      },
    };
    const payload = JSON.stringify(event);
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const response = await handleStripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": signature, "content-type": "application/json" },
        body: payload,
      }),
    );
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { payout?: string; alerted?: boolean };
    expect(body.payout).toBe("pending");
    expect(body.alerted).toBe(true);
    expect(recordPendingPayout).toHaveBeenCalledOnce();
    expect(sendPayoutAlert).toHaveBeenCalledOnce();
  });

  it("rejects a bad signature without touching the ledger", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fan_token";
    const response = await handleStripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=deadbeef", "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(400);
    expect(recordPendingPayout).not.toHaveBeenCalled();
    expect(sendPayoutAlert).not.toHaveBeenCalled();
  });
});
