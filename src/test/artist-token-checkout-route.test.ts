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

import { POST } from "@/app/api/checkout/artist-token/route";

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";

function checkoutRequest(body: unknown, origin = "http://127.0.0.1:8080"): Request {
  return new Request("http://127.0.0.1:8080/api/checkout/artist-token", {
    method: "POST",
    headers: { "content-type": "application/json", origin, authorization: "Bearer a.b.c" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/checkout/artist-token", () => {
  const originalSecret = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    createMock.mockReset();
    ctorArgs.length = 0;
    resolveStudioSessionMock.mockReset();
    if (originalSecret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalSecret;
  });

  function ready() {
    process.env.STRIPE_SECRET_KEY = "sk_test_artist_token";
    resolveStudioSessionMock.mockResolvedValue({
      userId: LEDGER_USER,
      email: "fan@example.com",
    });
    createMock.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_test_artist" });
  }

  it("returns 401 without a session and does not call Stripe", async () => {
    ready();
    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));

    const res = await POST(
      checkoutRequest({ artistId: "stephen-p-shaw", trackId: "vbf-africa", buyerId: "someone-else" }),
    );

    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("returns 400 when artistId or trackId is missing", async () => {
    ready();

    const noArtist = await POST(checkoutRequest({ trackId: "vbf-africa" }));
    const noTrack = await POST(checkoutRequest({ artistId: "stephen-p-shaw" }));

    expect(noArtist.status).toBe(400);
    expect(noTrack.status).toBe(400);
    await expect(noArtist.json()).resolves.toEqual({ error: "artistId and trackId are required." });
    expect(createMock).not.toHaveBeenCalled();
    expect(ctorArgs).toEqual([]);
  });

  it("creates a $1 payment and stores the session user as buyerId", async () => {
    ready();

    const res = await POST(
      checkoutRequest({
        artistId: "stephen-p-shaw",
        trackId: "vbf-africa",
        buyerId: "someone-else",
        unit_amount: 5000,
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      url: "https://checkout.stripe.com/c/pay/cs_test_artist",
    });

    const params = createMock.mock.calls[0][0] as {
      mode: string;
      client_reference_id: string;
      customer_email?: string;
      metadata: Record<string, string>;
      success_url: string;
      cancel_url: string;
      line_items: Array<{
        quantity: number;
        price_data: { currency: string; unit_amount: number; product_data: { name: string } };
      }>;
    };
    expect(params.mode).toBe("payment");
    expect(params.client_reference_id).toBe(LEDGER_USER);
    expect(params.customer_email).toBe("fan@example.com");
    expect(params.line_items).toEqual([
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 100,
          product_data: { name: "Artist Support Token ($1.00)" },
        },
      },
    ]);
    expect(params.metadata).toEqual({
      type: "artist_token",
      artistId: "stephen-p-shaw",
      trackId: "vbf-africa",
      buyerId: LEDGER_USER,
    });
    expect(params.success_url).toContain("/portal?tab=catalog_merch");
    expect(params.cancel_url).toContain("/portal?tab=catalog_merch");
    expect(JSON.stringify(params)).not.toContain("someone-else");
    expect(JSON.stringify(params)).not.toContain("5000");
    expect(ctorArgs).toEqual([["sk_test_artist_token", { apiVersion: "2026-03-25.dahlia" }]]);
  });
});
