import { afterEach, describe, expect, it, vi } from "vitest";

const { constructEventMock, events, profileWrites, fetchMock, creditCalls, creditGate } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  events: new Set<string>(),
  profileWrites: [] as Array<Record<string, unknown>>,
  fetchMock: vi.fn(),
  creditCalls: [] as Array<Record<string, unknown>>,
  creditGate: { fail: false },
}));

vi.mock("stripe", () => {
  class StripeMock {
    constructor(_key: string, _opts: unknown) {}
    static webhooks = {
      constructEvent: (...args: unknown[]) => constructEventMock(...args),
    };
  }
  return { default: StripeMock };
});

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
            if (events.has(row.event_id)) {
              return { error: { code: "23505", message: "duplicate" } };
            }
            events.add(row.event_id);
            return { error: null };
          },
        };
      }
      if (table === "artist_profiles") {
        return {
          upsert: async (row: Record<string, unknown>) => {
            profileWrites.push(row);
            return { error: null };
          },
        };
      }
      return {
        upsert: async () => ({ error: { message: `unexpected table ${table}` } }),
        insert: async () => ({ error: { message: `unexpected table ${table}` } }),
      };
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "credit_token_purchase") {
        return { data: null, error: { message: `unexpected rpc ${fn}` } };
      }
      creditCalls.push(args);
      if (creditGate.fail) {
        return { data: null, error: { message: "db down" } };
      }
      return {
        data: [{ credited: args._tokens, balance: args._tokens, already_credited: false }],
        error: null,
      };
    },
  }),
}));

import { POST } from "@/app/api/stripe/webhook/route";

const VOCAL_CLONE_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/vocal-clone";

function webhookRequest(body = "{}"): Request {
  return new Request("http://localhost/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=test", "content-type": "application/json" },
    body,
  });
}

const LEDGER_USER = "11111111-1111-4111-8111-111111111111";

function completedEvent(
  metadata: Record<string, string> | null,
  id = "evt_voice_1",
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_voice", metadata, ...extra } },
  };
}

describe("POST /api/stripe/webhook", () => {
  const originalFlag = process.env.ENABLE_WAVESPEED_ENROLLMENT;

  afterEach(() => {
    constructEventMock.mockReset();
    events.clear();
    profileWrites.length = 0;
    creditCalls.length = 0;
    creditGate.fail = false;
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    if (originalFlag === undefined) delete process.env.ENABLE_WAVESPEED_ENROLLMENT;
    else process.env.ENABLE_WAVESPEED_ENROLLMENT = originalFlag;
  });

  function readyEnv() {
    delete process.env.ENABLE_WAVESPEED_ENROLLMENT;
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.WAVESPEED_API_KEY = "test-key";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (url: string) => {
      if (url === VOCAL_CLONE_URL) {
        return new Response(JSON.stringify({ data: { vocal_id: "vocal-enrolled-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("rejects a bad signature with Webhook Error", async () => {
    readyEnv();
    constructEventMock.mockImplementation(() => {
      throw new Error("No signatures found matching the expected signature for payload");
    });

    const res = await POST(webhookRequest("{}"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "Webhook Error: No signatures found matching the expected signature for payload",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(profileWrites).toEqual([]);
  });

  it("returns 400 when checkout metadata has no userId", async () => {
    readyEnv();
    constructEventMock.mockReturnValue(completedEvent({}));

    const res = await POST(webhookRequest());

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Missing userId in metadata" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(profileWrites).toEqual([]);
  });

  it("writes a mock vocal id and does not call vocal-clone when the air-gap flag is unset", async () => {
    readyEnv();
    expect(process.env.ENABLE_WAVESPEED_ENROLLMENT).toBeUndefined();
    constructEventMock.mockReturnValue(
      completedEvent({
        userId: "user-1",
        sampleAudioUrl: "https://project.supabase.co/storage/v1/object/public/voice-samples/user-1/take.wav",
      }),
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(profileWrites).toHaveLength(1);
    expect(profileWrites[0]).toMatchObject({
      user_id: "user-1",
      is_voice_enrolled: true,
    });
    expect(String(profileWrites[0]?.vocal_id)).toMatch(/^mock_voc_/);
  });

  it("calls vocal-clone once when the flag is true, and a retry of the same event does not call it again", async () => {
    readyEnv();
    process.env.ENABLE_WAVESPEED_ENROLLMENT = "true";
    const sampleAudioUrl =
      "https://project.supabase.co/storage/v1/object/public/voice-samples/user-1/take.wav";
    constructEventMock.mockReturnValue(
      completedEvent({ userId: "user-1", sampleAudioUrl }, "evt_voice_live"),
    );

    const first = await POST(webhookRequest());
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true });
    await expect(second.json()).resolves.toEqual({ received: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VOCAL_CLONE_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ audio: sampleAudioUrl });
    expect(profileWrites).toEqual([
      {
        user_id: "user-1",
        vocal_id: "vocal-enrolled-1",
        is_voice_enrolled: true,
      },
    ]);
    delete process.env.ENABLE_WAVESPEED_ENROLLMENT;
  });

  it("acknowledges other event types without writing a profile", async () => {
    readyEnv();
    constructEventMock.mockReturnValue({
      id: "evt_other",
      type: "payment_intent.succeeded",
      data: { object: {} },
    });

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(profileWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.size).toBe(0);
    expect(creditCalls).toEqual([]);
  });

  it("credits a token pack once and does not enroll a voice", async () => {
    readyEnv();
    constructEventMock.mockReturnValue(
      completedEvent({ tokens: "5", userId: LEDGER_USER }, "evt_tokens_1", {
        id: "cs_tokens_1",
        amount_total: 1000,
        currency: "usd",
      }),
    );

    const first = await POST(webhookRequest());
    const second = await POST(webhookRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ received: true });
    await expect(second.json()).resolves.toEqual({ received: true });
    expect(creditCalls).toEqual([
      {
        _user_id: LEDGER_USER,
        _session_id: "cs_tokens_1",
        _price_id: "billing_ep",
        _tokens: 5,
        _amount_total: 1000,
        _currency: "usd",
      },
    ]);
    expect(profileWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.has("evt_tokens_1")).toBe(true);
  });

  it("does not claim a token event when the ledger write fails, so a retry can credit", async () => {
    readyEnv();
    creditGate.fail = true;
    constructEventMock.mockReturnValue(
      completedEvent({ tokens: "1", userId: LEDGER_USER }, "evt_tokens_retry", {
        id: "cs_tokens_retry",
      }),
    );

    const first = await POST(webhookRequest());
    expect(first.status).toBe(500);
    expect(events.has("evt_tokens_retry")).toBe(false);

    creditGate.fail = false;
    const second = await POST(webhookRequest());
    expect(second.status).toBe(200);
    expect(creditCalls).toHaveLength(2);
    expect(events.has("evt_tokens_retry")).toBe(true);
    expect(profileWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("acks a guest token checkout without writing a balance", async () => {
    readyEnv();
    constructEventMock.mockReturnValue(
      completedEvent({ tokens: "12", userId: "guest_user" }, "evt_tokens_guest"),
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(creditCalls).toEqual([]);
    expect(profileWrites).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not credit an unpaid token checkout", async () => {
    readyEnv();
    constructEventMock.mockReturnValue(
      completedEvent({ tokens: "1", userId: LEDGER_USER }, "evt_tokens_unpaid", {
        payment_status: "unpaid",
      }),
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(creditCalls).toEqual([]);
    expect(events.size).toBe(0);
  });

  it("keeps voice enrollment when a session also carries a sample URL", async () => {
    readyEnv();
    constructEventMock.mockReturnValue(
      completedEvent({
        tokens: "5",
        userId: "user-1",
        sampleAudioUrl: "https://project.supabase.co/storage/v1/object/public/voice-samples/user-1/take.wav",
      }),
    );

    const res = await POST(webhookRequest());

    expect(res.status).toBe(200);
    expect(profileWrites).toHaveLength(1);
    expect(profileWrites[0]).toMatchObject({ user_id: "user-1", is_voice_enrolled: true });
    expect(creditCalls).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
