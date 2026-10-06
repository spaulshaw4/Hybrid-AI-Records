import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveStudioSessionMock, maybeSingleMock } = vi.hoisted(() => ({
  resolveStudioSessionMock: vi.fn(),
  maybeSingleMock: vi.fn(),
}));

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
}));

import { GET } from "@/app/api/user/balance/route";

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";

function balanceRequest(userId?: string, authorization?: string): Request {
  const url = new URL("http://localhost/api/user/balance");
  if (userId) url.searchParams.set("userId", userId);
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new Request(url, { method: "GET", headers });
}

describe("GET /api/user/balance", () => {
  afterEach(() => {
    resolveStudioSessionMock.mockReset();
    maybeSingleMock.mockReset();
  });

  function signedIn(balance: number | null) {
    maybeSingleMock.mockResolvedValue({ data: balance == null ? null : { balance }, error: null });
    resolveStudioSessionMock.mockResolvedValue({
      userId: LEDGER_USER,
      supabase: {
        from: () => ({
          select: () => ({
            eq: () => ({
              maybeSingle: () => maybeSingleMock(),
            }),
          }),
        }),
      },
    });
  }

  it("returns the signed-in user's token_balances row", async () => {
    signedIn(7);

    const res = await GET(balanceRequest(LEDGER_USER, "Bearer a.b.c"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ balance: 7 });
    expect(maybeSingleMock).toHaveBeenCalledOnce();
  });

  it("returns 0 when the signed-in user has no balance row", async () => {
    signedIn(null);

    const res = await GET(balanceRequest(LEDGER_USER, "Bearer a.b.c"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ balance: 0 });
  });

  it("returns 0 for a signed-out request and does not query", async () => {
    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));

    const res = await GET(balanceRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ balance: 0 });
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });

  it("returns 0 for guest_user without querying", async () => {
    const res = await GET(balanceRequest("guest_user"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ balance: 0 });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
  });

  it("rejects a userId that does not match the session", async () => {
    signedIn(4);

    const res = await GET(balanceRequest("22222222-2222-4222-8222-222222222222", "Bearer a.b.c"));

    expect(res.status).toBe(403);
    expect(maybeSingleMock).not.toHaveBeenCalled();
  });
});
