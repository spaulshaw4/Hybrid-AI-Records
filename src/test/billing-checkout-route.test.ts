import { afterEach, describe, expect, it, vi } from "vitest";

const { createMock, ctorArgs, resolveStudioSessionMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  ctorArgs: [] as unknown[],
  resolveStudioSessionMock: vi.fn(),
}));

vi.mock("stripe", () => {
  class StripeMock {
    checkout = {
      sessions: {
        create: (...args: unknown[]) => createMock(...args),
      },
    };
    constructor(key: string, opts: unknown) {
      ctorArgs.push([key, opts]);
    }
  }
  return { default: StripeMock };
});

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
}));

import { POST } from "@/app/api/billing/checkout/route";

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";

function checkoutRequest(body: unknown, origin = "http://localhost:5173", authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/billing/checkout", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/billing/checkout", () => {
  const originalSecret = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    createMock.mockReset();
    ctorArgs.length = 0;
    resolveStudioSessionMock.mockReset();
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
  });

  function ready() {
    process.env.STRIPE_SECRET_KEY = "sk_test_checkout_route";
    resolveStudioSessionMock.mockResolvedValue({ userId: LEDGER_USER });
    createMock.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_route" });
  }

  it("prices each tier, omits payment_method_types, and defaults an unknown tier to single", async () => {
    ready();

    const ep = await POST(checkoutRequest({ tier: "ep" }));
    const album = await POST(checkoutRequest({ tier: "album", userId: LEDGER_USER }));
    const unknown = await POST(checkoutRequest({ tier: "nope" }));

    expect(ep.status).toBe(200);
    expect(album.status).toBe(200);
    expect(unknown.status).toBe(200);
    await expect(ep.json()).resolves.toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_route" });

    const epParams = createMock.mock.calls[0][0] as {
      mode: string;
      payment_method_types?: unknown;
      success_url: string;
      cancel_url: string;
      metadata: { tokens: string; userId: string };
      line_items: Array<{
        quantity: number;
        price_data: {
          currency: string;
          unit_amount: number;
          product_data: { name: string; description: string };
        };
      }>;
    };
    expect(epParams.mode).toBe("payment");
    expect(epParams.payment_method_types).toBeUndefined();
    expect(epParams.line_items[0]).toEqual({
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: 1000,
        product_data: {
          name: "5 Hybrid Tokens (EP Pack)",
          description: "Master release generation token for Hybrid AI Records Studio",
        },
      },
    });
    expect(epParams.metadata).toEqual({ tokens: "5", userId: LEDGER_USER });
    expect(epParams.success_url).toBe(
      "http://localhost:5173/engine?payment=success&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(epParams.cancel_url).toBe("http://localhost:5173/engine?payment=cancelled");

    const albumParams = createMock.mock.calls[1][0] as {
      metadata: { tokens: string; userId: string };
      line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } } }>;
    };
    expect(albumParams.line_items[0].price_data.unit_amount).toBe(2000);
    expect(albumParams.line_items[0].price_data.product_data.name).toBe("12 Hybrid Tokens (Album Pack)");
    expect(albumParams.metadata).toEqual({ tokens: "12", userId: LEDGER_USER });

    const singleParams = createMock.mock.calls[2][0] as {
      metadata: { tokens: string };
      line_items: Array<{ price_data: { unit_amount: number; product_data: { name: string } } }>;
    };
    expect(singleParams.line_items[0].price_data.unit_amount).toBe(200);
    expect(singleParams.line_items[0].price_data.product_data.name).toBe("1 Hybrid Token");
    expect(singleParams.metadata.tokens).toBe("1");

    expect(ctorArgs).toEqual([
      ["sk_test_checkout_route", { apiVersion: "2026-03-25.dahlia" }],
      ["sk_test_checkout_route", { apiVersion: "2026-03-25.dahlia" }],
      ["sk_test_checkout_route", { apiVersion: "2026-03-25.dahlia" }],
    ]);
  });

  it("refuses a signed-out checkout and does not open a Stripe session", async () => {
    ready();
    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));

    const res = await POST(checkoutRequest({ tier: "single", userId: LEDGER_USER }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      error:
        "Please sign in to your Hybrid AI Records account before purchasing tokens so they can be credited to your vault.",
    });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("uses a verified session user id and ignores a mismatched body userId", async () => {
    ready();
    resolveStudioSessionMock.mockResolvedValue({ userId: LEDGER_USER });

    const res = await POST(
      checkoutRequest({ tier: "single", userId: "someone-else" }, "http://localhost:5173", "Bearer a.b.c"),
    );

    expect(res.status).toBe(200);
    const params = createMock.mock.calls[0][0] as { metadata: { userId: string; tokens: string } };
    expect(params.metadata).toEqual({ tokens: "1", userId: LEDGER_USER });
  });

  it("falls back to the canonical origin when Origin is off the allowlist", async () => {
    ready();

    const res = await POST(checkoutRequest({ tier: "single" }, "https://evil.example"));

    expect(res.status).toBe(200);
    const params = createMock.mock.calls[0][0] as { success_url: string; cancel_url: string };
    expect(params.success_url).toBe(
      "https://hybrid-ai-records.com/engine?payment=success&session_id={CHECKOUT_SESSION_ID}",
    );
    expect(params.cancel_url).toBe("https://hybrid-ai-records.com/engine?payment=cancelled");
  });

  it("fails clearly when STRIPE_SECRET_KEY is empty and does not construct Stripe", async () => {
    ready();
    process.env.STRIPE_SECRET_KEY = "   ";

    const res = await POST(checkoutRequest({ tier: "single" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "STRIPE_SECRET_KEY is not configured" });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns the Stripe error message without calling the live API", async () => {
    ready();
    createMock.mockRejectedValue(new Error("Stripe is mocked"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await POST(checkoutRequest({ tier: "album" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Stripe is mocked" });
    expect(errorSpy).toHaveBeenCalledWith("[Stripe Checkout Error]:", expect.any(Error));
    errorSpy.mockRestore();
  });
});
