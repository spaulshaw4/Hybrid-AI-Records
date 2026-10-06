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
    vi.useRealTimers();
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
    await expect(res.json()).resolves.toEqual({ error: "Missing WAVESPEED_API_KEY in environment variables." });
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
    await expect(res.json()).resolves.toEqual({
      success: true,
      title: "Night",
      lyrics: "the porch light stays on",
      result: "the porch light stays on",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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

  it("prefers topic over prompt and lyrics for the generate-lyrics prompt", async () => {
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
    await expect(res.json()).resolves.toEqual({
      success: true,
      title: "Night",
      lyrics: "[Verse]\nkept line",
      result: "[Verse]\nkept line",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    expect(requestBody(fetchMock.mock.calls[0] as unknown[])).toEqual({
      prompt: "rain",
      title: "Night",
    });
    assertChatNotCalled(fetchMock);
  });

  it("sends prompt from text when enhance_match_vibe posts only action, text, and title", async () => {
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
    await expect(res.json()).resolves.toEqual({
      success: true,
      title: "Night Drive",
      lyrics: "brush drums, wider room",
      result: "brush drums, wider room",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    const payload = requestBody(fetchMock.mock.calls[0] as unknown[]);
    expect(payload.prompt).toBe("brush drums and dusty baritone");
    expect(payload).toEqual({
      prompt: "brush drums and dusty baritone",
      title: "Night Drive",
    });
    assertChatNotCalled(fetchMock);
  });

  it("uses the lyric draft when topic, prompt, and text are empty", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ lyrics: "[Chorus]\nmoonlit" }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({
        action: "generate_lyrics",
        topic: "   ",
        lyrics: "the moon in my eyes color the night",
        title: "Night",
      }),
    );

    expect(res.status).toBe(200);
    expect(requestBody(fetchMock.mock.calls[0] as unknown[])).toEqual({
      prompt: "the moon in my eyes color the night",
      title: "Night",
    });
    assertChatNotCalled(fetchMock);
  });

  it("picks a random theme when every input is blank", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ lyrics: "[Verse]\nneon" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Math, "random").mockReturnValue(0);

    const res = await POST(aiRequest({ action: "generate_lyrics", topic: "", lyrics: "", title: "" }));

    expect(res.status).toBe(200);
    expect(requestBody(fetchMock.mock.calls[0] as unknown[])).toEqual({
      prompt: "Late night drive under neon lights and moonlit skies",
      title: "Untitled Track",
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

  it("polls a processing task and returns the completed lyrics and title", async () => {
    vi.useFakeTimers();
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/predictions/")) {
        return jsonResponse({
          data: {
            status: "completed",
            outputs: ['{"title":"Neon Dreams","lyrics":"[Intro]\\nneon"}'],
          },
        });
      }
      return jsonResponse({
        code: 200,
        data: {
          id: "b16e1f7eb5284c3bac38ecce41847415",
          status: "processing",
          urls: { get: "https://api.wavespeed.ai/api/v3/predictions/b16e1f7eb5284c3bac38ecce41847415/result" },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = POST(aiRequest({ action: "generate_lyrics", topic: "neon", title: "Night Drive" }));
    await vi.runAllTimersAsync();
    const res = await pending;

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      title: "Neon Dreams",
      lyrics: "[Intro]\nneon",
      result: "[Intro]\nneon",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String((fetchMock.mock.calls[1] as unknown as [string])[0])).toBe(
      "https://api.wavespeed.ai/api/v3/predictions/b16e1f7eb5284c3bac38ecce41847415/result",
    );
  });

  it("returns 500 when polling never finishes", async () => {
    vi.useFakeTimers();
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/predictions/")) {
        return jsonResponse({ data: { id: "pred_123", status: "processing" } });
      }
      return jsonResponse({ id: "pred_123", status: "created" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = POST(aiRequest({ action: "generate_topic", title: "Night", topic: "rain" }));
    await vi.runAllTimersAsync();
    const res = await pending;
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("WaveSpeed prediction timed out after 50 seconds.");
    expect(errorSpy).toHaveBeenCalledWith("[WaveSpeed Route Handler Error]:", expect.any(Error));
    expect(fetchMock.mock.calls.length).toBe(1 + 25);
  });

  it("returns 500 when a completed task has no lyric text", async () => {
    vi.useFakeTimers();
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => jsonResponse({ data: { id: "pred_123", status: "completed" } }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const pending = POST(aiRequest({ action: "generate_topic", title: "Night", topic: "rain" }));
    await vi.runAllTimersAsync();
    const res = await pending;
    const body = (await res.json()) as { error: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("WaveSpeed completed but returned empty lyrics.");
    expect(errorSpy).toHaveBeenCalledWith("[WaveSpeed Raw Response]:", expect.stringContaining("pred_123"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GENERATE_URL);
    expect(String((fetchMock.mock.calls[1] as unknown as [string])[0])).toBe(
      "https://api.wavespeed.ai/api/v3/predictions/pred_123/result",
    );
  });

  it("reads lyrics from WaveSpeed output, outputs, and data.outputs", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const shapes = [
      { output: { lyrics: "[Verse]\nporch light" } },
      { outputs: ["[Chorus]\nsteel guitar"] },
      { data: { outputs: [{ text: "[Bridge]\ndusk on the rail" }] } },
      { data: { output: ["[Outro]\nlast train"] } },
    ];
    const expected = [
      "[Verse]\nporch light",
      "[Chorus]\nsteel guitar",
      "[Bridge]\ndusk on the rail",
      "[Outro]\nlast train",
    ];

    for (let index = 0; index < shapes.length; index += 1) {
      const fetchMock = vi.fn(async () => jsonResponse(shapes[index]));
      vi.stubGlobal("fetch", fetchMock);
      const res = await POST(aiRequest({ action: "generate_lyrics", topic: "dusk", title: "Porch" }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        success: true,
        title: "Porch",
        lyrics: expected[index],
        result: expected[index],
      });
    }
  });
});
