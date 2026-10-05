// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { sessionFromCreateResponse } from "@/lib/create-session-id";
import {
  LYRIA_MODEL_ID,
  MINIMAX_VERSION_ID,
  handleTrackCreate,
  resetTrackCreateForTests,
} from "@/lib/track-create.server";

const PROMPT = "A bright analog house groove with a soft vocal hook and roomy drums tonight.";

const originalFetch = globalThis.fetch;
const originalToken = process.env.REPLICATE_API_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetTrackCreateForTests();
  if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
  else process.env.REPLICATE_API_TOKEN = originalToken;
});

function jsonRequest(body: unknown): Request {
  return new Request("http://127.0.0.1:3000/api/tracks/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/tracks/create on port 3000", () => {
  it("returns 200 pending JSON before any Replicate HTTP call", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const calls: string[] = [];
    let allowModel = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!allowModel) {
        throw new Error(`Replicate was called before the create response: ${url}`);
      }
      calls.push(url);
      return new Response(JSON.stringify({ id: "pred_test", status: "failed", error: "mocked" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    let blocked: ReturnType<typeof setTimeout> | undefined;
    const response = await Promise.race([
      handleTrackCreate(jsonRequest({ prompt: PROMPT })),
      new Promise<Response>((_, reject) => {
        blocked = setTimeout(
          () => reject(new Error("create handler blocked before returning pending JSON")),
          500,
        );
      }),
    ]);
    if (blocked) clearTimeout(blocked);

    expect(calls).toEqual([]);
    expect(response.status).toBe(200);
    allowModel = true;
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: true,
      status: "pending",
      session_id: body.session_id,
      sessionId: body.session_id,
      track_id: body.session_id,
      id: body.session_id,
      token_cost: 1,
      vocal_present: false,
    });
    expect(body.master_url).toBeUndefined();
    expect(String(body.session_id)).toMatch(/^ht_[0-9a-f]{12}$/);
    expect(sessionFromCreateResponse(response, body)).toBe(body.session_id);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.some((url) => url.includes(`/models/${LYRIA_MODEL_ID}/predictions`))).toBe(true);
    expect(calls.some((url) => url.includes("8880"))).toBe(false);
    expect(calls.some((url) => url.includes(MINIMAX_VERSION_ID))).toBe(false);
  });

  it("saves a vocal and schedules one instrumental minimax prediction without uploading it", async () => {
    process.env.REPLICATE_API_TOKEN = "test-token-not-live";
    const seen: Array<{ url: string; body: string }> = [];
    let allowModel = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!allowModel) throw new Error("Replicate was called before the create response");
      seen.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      return new Response(JSON.stringify({ id: "pred_test", status: "failed", error: "mocked" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const form = new FormData();
    form.append("prompt", PROMPT);
    form.append("bpm", "100");
    form.append(
      "vocal_file",
      new File([new Uint8Array(128)], "ref_vocal.wav", { type: "audio/wav" }),
      "ref_vocal.wav",
    );
    const request = new Request("http://127.0.0.1:3000/api/tracks/create", { method: "POST", body: form });
    const response = await handleTrackCreate(request);
    expect(seen).toEqual([]);
    expect(response.status).toBe(200);
    allowModel = true;
    const body = (await response.json()) as { vocal_present: boolean; session_id: string };
    expect(body.vocal_present).toBe(true);
    expect(body.session_id).toMatch(/^ht_[0-9a-f]{12}$/);

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/predictions$/);
    expect(seen[0].url).not.toContain(LYRIA_MODEL_ID);
    const payload = JSON.parse(seen[0].body) as {
      version: string;
      input: Record<string, unknown>;
    };
    expect(payload.version).toBe(MINIMAX_VERSION_ID);
    expect(payload.input.is_instrumental).toBe(true);
    expect(JSON.stringify(payload.input)).not.toMatch(/audio_file|ref_vocal|data:audio/i);
    expect(payload.input).not.toHaveProperty("audio");
  });
});
