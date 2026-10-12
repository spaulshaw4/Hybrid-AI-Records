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

  const originalPair5 = process.env.STRIPE_PRICE_PAIR_5;
  const originalPair10 = process.env.STRIPE_PRICE_PAIR_10;
  const originalPair25 = process.env.STRIPE_PRICE_PAIR_25;
  const originalH = process.env.STRIPE_PRICE_H_TOKEN;
  const originalD = process.env.STRIPE_PRICE_D_TOKEN;
  const originalArtist = process.env.STRIPE_PRICE_ARTIST_TOKEN;

  afterEach(() => {
    createMock.mockReset();
    ctorArgs.length = 0;
    resolveStudioSessionMock.mockReset();
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
    if (originalPair5 === undefined) delete process.env.STRIPE_PRICE_PAIR_5;
    else process.env.STRIPE_PRICE_PAIR_5 = originalPair5;
    if (originalPair10 === undefined) delete process.env.STRIPE_PRICE_PAIR_10;
    else process.env.STRIPE_PRICE_PAIR_10 = originalPair10;
    if (originalPair25 === undefined) delete process.env.STRIPE_PRICE_PAIR_25;
    else process.env.STRIPE_PRICE_PAIR_25 = originalPair25;
    if (originalH === undefined) delete process.env.STRIPE_PRICE_H_TOKEN;
    else process.env.STRIPE_PRICE_H_TOKEN = originalH;
    if (originalD === undefined) delete process.env.STRIPE_PRICE_D_TOKEN;
    else process.env.STRIPE_PRICE_D_TOKEN = originalD;
    if (originalArtist === undefined) delete process.env.STRIPE_PRICE_ARTIST_TOKEN;
    else process.env.STRIPE_PRICE_ARTIST_TOKEN = originalArtist;
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

  it("keeps the D-token refill packs on their existing prices", async () => {
    ready();

    const res = await POST(checkoutRequest({ tier: "d5", priceId: "price_from_browser" }));

    expect(res.status).toBe(200);
    const params = createMock.mock.calls[0][0] as {
      mode: string;
      metadata: { tokens: string; pack: string; userId: string };
      line_items: Array<{ price?: string; price_data?: { unit_amount: number; product_data: { name: string } } }>;
    };
    expect(params.mode).toBe("payment");
    expect(params.line_items[0].price).toBeUndefined();
    expect(params.line_items[0].price_data?.unit_amount).toBe(500);
    expect(params.line_items[0].price_data?.product_data.name).toBe("5 D-Token");
    expect(params.metadata).toEqual({ tokens: "5", userId: LEDGER_USER, pack: "d5" });
    expect(JSON.stringify(params)).not.toContain("price_from_browser");
  });

  it("bills a pair top-up from the server price env and ignores a client price id", async () => {
    ready();
    process.env.STRIPE_PRICE_PAIR_5 = "price_pair_5_test";
    process.env.STRIPE_PRICE_PAIR_10 = "price_pair_10_test";
    process.env.STRIPE_PRICE_PAIR_25 = "price_pair_25_test";

    const five = await POST(checkoutRequest({ tier: "pair5", priceId: "price_from_browser", userId: "someone-else" }));
    const ten = await POST(checkoutRequest({ tier: "pair10" }));
    const twentyFive = await POST(checkoutRequest({ tier: "pair25" }));

    expect(five.status).toBe(200);
    expect(ten.status).toBe(200);
    expect(twentyFive.status).toBe(200);

    const fiveParams = createMock.mock.calls[0][0] as {
      mode: string;
      line_items: Array<{ price: string; quantity: number; price_data?: unknown }>;
      metadata: Record<string, string>;
      success_url: string;
    };
    expect(fiveParams.mode).toBe("payment");
    expect(fiveParams.line_items).toEqual([{ price: "price_pair_5_test", quantity: 1 }]);
    expect(fiveParams.metadata).toEqual({
      tokens: "5",
      dTokens: "5",
      userId: LEDGER_USER,
      pack: "pair5",
      kind: "pair_topup",
    });
    expect(fiveParams.success_url).toContain("/portal?tab=plans&payment=success");
    expect(JSON.stringify(fiveParams)).not.toContain("price_from_browser");
    expect(JSON.stringify(fiveParams)).not.toContain("someone-else");

    const tenParams = createMock.mock.calls[1][0] as {
      line_items: Array<{ price: string }>;
      metadata: { tokens: string; dTokens: string; pack: string };
    };
    expect(tenParams.line_items[0].price).toBe("price_pair_10_test");
    expect(tenParams.metadata).toMatchObject({ tokens: "10", dTokens: "10", pack: "pair10" });

    const largeParams = createMock.mock.calls[2][0] as {
      line_items: Array<{ price: string }>;
      metadata: { tokens: string; dTokens: string; pack: string };
    };
    expect(largeParams.line_items[0].price).toBe("price_pair_25_test");
    expect(largeParams.metadata).toMatchObject({ tokens: "25", dTokens: "25", pack: "pair25" });

    expect(ctorArgs.map((entry) => (entry as [string, { apiVersion: string }])[1])).toEqual([
      { apiVersion: "2026-03-25.dahlia" },
      { apiVersion: "2026-03-25.dahlia" },
      { apiVersion: "2026-03-25.dahlia" },
    ]);
  });

  it("returns 503 for a pair top-up when its price env is missing and does not call Stripe", async () => {
    ready();
    delete process.env.STRIPE_PRICE_PAIR_5;

    const res = await POST(checkoutRequest({ tier: "pair5", priceId: "price_from_browser" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({ error: "Token packs are not configured." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 401 for a single-token checkout without a session and does not call Stripe", async () => {
    ready();
    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));

    const res = await POST(checkoutRequest({ tokenType: "h_token", quantity: 1, userId: LEDGER_USER }));

    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 400 for a bad token type or an artist quantity of 0 or 101", async () => {
    ready();
    process.env.STRIPE_PRICE_ARTIST_TOKEN = "price_artist_token_test";

    const badType = await POST(checkoutRequest({ tokenType: "credits", quantity: 1 }));
    const zero = await POST(checkoutRequest({ tokenType: "artist_token", quantity: 0 }));
    const tooMany = await POST(checkoutRequest({ tokenType: "artist_token", quantity: 101 }));

    expect(badType.status).toBe(400);
    expect(zero.status).toBe(400);
    expect(tooMany.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 503 when a single-token price env is missing and does not call Stripe", async () => {
    ready();
    delete process.env.STRIPE_PRICE_H_TOKEN;
    delete process.env.STRIPE_PRICE_D_TOKEN;
    delete process.env.STRIPE_PRICE_ARTIST_TOKEN;

    const h = await POST(checkoutRequest({ tokenType: "h_token", quantity: 1, priceId: "price_from_browser" }));
    const d = await POST(checkoutRequest({ tokenType: "d_token", quantity: 1 }));
    const artist = await POST(checkoutRequest({ tokenType: "artist_token", quantity: 5 }));

    expect(h.status).toBe(503);
    expect(d.status).toBe(503);
    expect(artist.status).toBe(503);
    await expect(h.json()).resolves.toEqual({ error: "Token checkout is not configured." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("creates a payment session from the server price env and ignores a body userId", async () => {
    ready();
    process.env.STRIPE_PRICE_H_TOKEN = "price_h_token_test";
    process.env.STRIPE_PRICE_D_TOKEN = "price_d_token_test";
    process.env.STRIPE_PRICE_ARTIST_TOKEN = "price_artist_token_test";
    resolveStudioSessionMock.mockResolvedValue({
      userId: LEDGER_USER,
      email: "artist@example.com",
    });

    const h = await POST(
      checkoutRequest({
        tokenType: "h_token",
        quantity: 1,
        userId: "someone-else",
        priceId: "price_from_browser",
      }),
    );
    const d = await POST(checkoutRequest({ tokenType: "d_token", quantity: 1, userId: "someone-else" }));
    const artist = await POST(
      checkoutRequest({ tokenType: "artist_token", quantity: 5, userId: "someone-else" }),
    );

    expect(h.status).toBe(200);
    expect(d.status).toBe(200);
    expect(artist.status).toBe(200);

    const hParams = createMock.mock.calls[0][0] as {
      mode: string;
      client_reference_id: string;
      customer_email?: string;
      line_items: Array<{ price: string; quantity: number; price_data?: unknown }>;
      metadata: Record<string, string>;
      payment_intent_data: { metadata: Record<string, string> };
      success_url: string;
      cancel_url: string;
    };
    expect(hParams.mode).toBe("payment");
    expect(hParams.client_reference_id).toBe(LEDGER_USER);
    expect(hParams.customer_email).toBe("artist@example.com");
    expect(hParams.line_items).toEqual([{ price: "price_h_token_test", quantity: 1 }]);
    expect(hParams.metadata).toEqual({ userId: LEDGER_USER, tokenType: "h_token", quantity: "1" });
    expect(hParams.payment_intent_data.metadata).toEqual(hParams.metadata);
    expect(hParams.success_url).toContain("/portal?tab=plans");
    expect(hParams.cancel_url).toContain("/portal?tab=plans");
    expect(JSON.stringify(hParams)).not.toContain("price_from_browser");
    expect(JSON.stringify(hParams)).not.toContain("someone-else");

    const dParams = createMock.mock.calls[1][0] as {
      line_items: Array<{ price: string; quantity: number }>;
      metadata: Record<string, string>;
    };
    expect(dParams.line_items).toEqual([{ price: "price_d_token_test", quantity: 1 }]);
    expect(dParams.metadata).toMatchObject({ tokenType: "d_token", quantity: "1", userId: LEDGER_USER });

    const artistParams = createMock.mock.calls[2][0] as {
      line_items: Array<{ price: string; quantity: number }>;
      metadata: Record<string, string>;
      client_reference_id: string;
    };
    expect(artistParams.line_items).toEqual([{ price: "price_artist_token_test", quantity: 5 }]);
    expect(artistParams.metadata).toEqual({
      userId: LEDGER_USER,
      tokenType: "artist_token",
      quantity: "5",
    });
    expect(artistParams.client_reference_id).toBe(LEDGER_USER);

    expect(ctorArgs.map((entry) => (entry as [string, { apiVersion: string }])[1])).toEqual([
      { apiVersion: "2026-03-25.dahlia" },
      { apiVersion: "2026-03-25.dahlia" },
      { apiVersion: "2026-03-25.dahlia" },
    ]);
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
