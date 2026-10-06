import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/ai/coproducer/route";

const CHAT_URL = "https://api.wavespeed.ai/v1/chat/completions";
const EXTEND_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/extend-lyrics";
const GENERATE_URL = "https://api.wavespeed.ai/api/v3/mureka-ai/generate-lyrics";

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

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function assertChatNotCalled(fetchMock: ReturnType<typeof vi.fn>): void {
  for (const call of fetchMock.mock.calls) {
    expect(String(call[0])).not.toBe(CHAT_URL);
    expect(String(call[0])).not.toContain("/v1/chat/completions");
  }
}

describe("POST /api/ai/coproducer", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalKey === undefined) delete process.env.WAVESPEED_API_KEY;
    else process.env.WAVESPEED_API_KEY = originalKey;
  });

  it("returns 500 when the WaveSpeed key is missing and does not call upstream", async () => {
    delete process.env.WAVESPEED_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "optimize", lyrics: "line one", title: "Night" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Missing WAVESPEED_API_KEY." });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts next_line to extend-lyrics and returns data.lyrics", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ lyrics: "the porch light stays on" }));
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const res = await POST(
      aiRequest({
        action: "next_line",
        lyrics: "existing couplet",
        text: "ignore this text field",
        title: "Night",
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, result: "the porch light stays on" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(EXTEND_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization.startsWith("Bearer ")).toBe(true);
    expect(requestBody(fetchMock.mock.calls[0] as unknown[])).toEqual({
      lyrics: "existing couplet",
      num_lines: 2,
    });
    assertChatNotCalled(fetchMock);
    const logged = logSpy.mock.calls.flat().map((part) => String(part)).join("\n");
    expect(logged).toContain("[WaveSpeed Mureka] next_line mureka-ai/extend-lyrics 200");
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain("Bearer");
    expect(logged).not.toContain("Authorization");
  });

  it("posts optimize to generate-lyrics with title, style from prompt, and theme from topic", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ lyrics: "[Verse]\nkept line" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({
        action: "optimize",
        lyrics: "line one",
        title: "Night",
        prompt: "dark trap",
        topic: "rain",
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, result: "[Verse]\nkept line" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    expect(requestBody(fetchMock.mock.calls[0] as unknown[])).toEqual({
      title: "Night",
      style: "dark trap",
      theme: "rain",
    });
    assertChatNotCalled(fetchMock);
  });

  it("sends style from text when enhance_match_vibe posts only action, text, and title", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ lyrics: "brush drums, wider room" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({
        action: "enhance_match_vibe",
        text: "brush drums and dusty baritone",
        title: "Night Drive",
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, result: "brush drums, wider room" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    const payload = requestBody(fetchMock.mock.calls[0] as unknown[]);
    expect(payload.style).toBe("brush drums and dusty baritone");
    expect(payload).toEqual({
      title: "Night Drive",
      style: "brush drums and dusty baritone",
      theme: "brush drums and dusty baritone",
    });
    assertChatNotCalled(fetchMock);
  });

  it("returns the upstream status and message for a rejected model", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ message: "no such model" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "optimize", lyrics: "line one", title: "Night" }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "no such model" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    assertChatNotCalled(fetchMock);
  });

  it("uses error.message when the upstream error is an object", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { message: "theme rejected", code: "bad_theme" } }, 422),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "section", lyrics: "line one", title: "Night" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(422);
    expect(body.error).toBe("theme rejected");
    expect(body.error).not.toContain("[object Object]");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns 502 with the raw shape when the response has only a task id", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ id: "pred_123", status: "created" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "generate_topic", title: "Night", topic: "rain" }));
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(502);
    expect(body.error).toContain("WaveSpeed Mureka returned no lyrics.");
    expect(body.error).toContain("pred_123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    assertChatNotCalled(fetchMock);
  });
});
