import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/ai/coproducer/route";

const CHAT_URL = "https://api.wavespeed.ai/v1/chat/completions";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function aiRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/ai/coproducer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/ai/coproducer", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;
  const originalModel = process.env.WAVESPEED_LLM_MODEL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.WAVESPEED_LLM_MODEL;
    else process.env.WAVESPEED_LLM_MODEL = originalModel;
  });

  it("returns 500 when the WaveSpeed key is missing and does not call upstream", async () => {
    delete process.env.WAVESPEED_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", text: "dark trap", title: "Night" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "WAVESPEED_API_KEY is missing." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses gemini-3.5-flash and max_tokens 1000 when WAVESPEED_LLM_MODEL is unset", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: "  brighter drums, minor key  " } }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({ action: "enhance_style", text: "dark trap", title: "Night", genre: "Rock" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      result: "brighter drums, minor key",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CHAT_URL);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: "Bearer test-key",
      "Content-Type": "application/json",
    });
    const payload = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.model).toBe("gemini-3.5-flash");
    expect(payload.temperature).toBe(0.7);
    expect(payload.max_tokens).toBe(1000);
    expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(payload.messages[1]?.content).toContain("dark trap");
  });

  it("sends WAVESPEED_LLM_MODEL when that value is set", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    process.env.WAVESPEED_LLM_MODEL = "override-flash";
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", text: "dark trap", title: "Night" }));

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as { model: string; max_tokens: number };
    expect(payload.model).toBe("override-flash");
    expect(payload.max_tokens).toBe(1000);
  });

  it("forwards an upstream error status and message", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "quota exceeded" } }, 429));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", text: "dark trap", title: "Night" }));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "quota exceeded" });
  });
});
