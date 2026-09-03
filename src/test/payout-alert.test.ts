/**
 * Payout routing alert: Resend first, mocked SDK — no live send.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() =>
  vi.fn(async () => ({ data: { id: "email_test_1" }, error: null })),
);

vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

import { sendPayoutAlert } from "@/lib/payout-alert.server";
import {
  DEFAULT_PAYOUT_ALERT_EMAIL,
  PAYOUT_ALERT_FROM,
} from "@/lib/fan-token-purchase";

const original = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  PAYOUT_ALERT_EMAIL: process.env.PAYOUT_ALERT_EMAIL,
  ALERT_EMAIL: process.env.ALERT_EMAIL,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
};

afterEach(() => {
  send.mockClear();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("sendPayoutAlert", () => {
  it("sends via Resend to Stephen with routing details (no money moved)", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    delete process.env.PAYOUT_ALERT_EMAIL;
    delete process.env.ALERT_EMAIL;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PASSWORD;

    const result = await sendPayoutAlert({
      event: "token.purchased",
      data: {
        token_amount: 1,
        currency: "USD",
        song_title: "Heavy Sky",
        artist_name: "Jester",
        artist_payout_target: "paypal@artistdomain.com",
        buyer_email: "fan@example.com",
        transaction_id: "tx_984729184",
      },
    });

    expect(result).toEqual({ ok: true });
    expect(send).toHaveBeenCalledOnce();
    const [body, opts] = send.mock.calls[0] as [
      {
        from: string;
        to: string[];
        subject: string;
        html: string;
        text: string;
      },
      { idempotencyKey?: string },
    ];
    expect(body.from).toBe(PAYOUT_ALERT_FROM);
    expect(body.to).toEqual([DEFAULT_PAYOUT_ALERT_EMAIL]);
    expect(body.subject).toContain("Jester");
    expect(body.text).toContain("paypal@artistdomain.com");
    expect(body.text).toContain("$1.00");
    expect(body.text).toMatch(/payout is 100% to that address/i);
    expect(body.html).toContain("Heavy Sky");
    expect(opts.idempotencyKey).toBe("payout-alert/tx_984729184");
  });
});
