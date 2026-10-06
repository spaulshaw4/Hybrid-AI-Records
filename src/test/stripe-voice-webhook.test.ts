import { afterEach, describe, expect, it, vi } from "vitest";

const { constructEventMock, events, profileWrites, fetchMock } = vi.hoisted(() => ({
  constructEventMock: vi.fn(),
  events: new Set<string>(),
  profileWrites: [] as Array<Record<string, unknown>>,
  fetchMock: vi.fn(),
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

function completedEvent(
  metadata: Record<string, string> | null,
  id = "evt_voice_1",
) {
  return {
    id,
    type: "checkout.session.completed",
    data: { object: { id: "cs_test_voice", metadata } },
  };
}

describe("POST /api/stripe/webhook", () => {
  const originalFlag = process.env.ENABLE_WAVESPEED_ENROLLMENT;

  afterEach(() => {
    constructEventMock.mockReset();
    events.clear();
    profileWrites.length = 0;
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
  });
});
