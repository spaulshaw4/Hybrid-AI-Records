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

const STYLE_MODEL = "anthropic/claude-fable-5";
const STYLE_SYSTEM = `You are an executive music producer and prompt designer for Mureka AI audio generation.
Your job is to output a single-line sonic production descriptor under 40 words.
Specify: Genre/subgenre, core instrumentation, exact tempo (BPM), vocal gender/timbre (e.g., deep baritone male vocal, warm soulful vocal), and acoustic space.
CONTEXT RULES:
1. IF LYRICS ARE PROVIDED: Analyze the theme, rhythm, and emotional weight of the lyrics. Design a sonic style that naturally carries that vocal delivery.
2. IF A SEED KEYWORD IS PROVIDED (e.g., "rock", "lo-fi", "country"): Expand that seed into a complete, professional studio arrangement.
3. IF NEITHER ARE PROVIDED: Act as "Surprise Me". Select a distinct, high-impact commercial genre and generate an original production blueprint.
STRICT TERMINATION:
- Output EVERYTHING on ONE single line.
- Do NOT write lyrics, rhymes, or [Verse]/[Chorus] tags.
- Do NOT include conversational intros or explanations.
- Stop immediately after the final descriptor tag.`;
const LYRIC_SYSTEM_WITH_GENRE = `You are a master songwriter and lyricist.
Write complete, compelling song lyrics based on the user's theme.
Musical Style Context: dark country.
MUREKA FORMATTING RULES:
1. Use standard structural headers on their own line: [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], [Chorus], [Outro].
2. Keep line syllable counts balanced (7-10 syllables per line) so the singer locks naturally to the pocket.
3. Use grounded, evocative imagery. Avoid cheap pop clichés.
4. Output ONLY the bracketed sections and lyrics. Do NOT include titles, commentary, or conversational notes.
5. Terminate immediately after the last line of [Outro].`;
const STYLE_TOKEN = "replicate-style-test-token";

function restoreEnv(name: "WAVESPEED_API_KEY" | "LYRIC_ENGINE_API_KEY" | "ENGINE_API_KEY" | "REPLICATE_API_TOKEN" | "REPLICATE_API_KEY", value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("POST /api/ai/coproducer", () => {
  const originalKey = process.env.WAVESPEED_API_KEY;
  const originalLyricKey = process.env.LYRIC_ENGINE_API_KEY;
  const originalEngineKey = process.env.ENGINE_API_KEY;
  const originalReplicateToken = process.env.REPLICATE_API_TOKEN;
  const originalReplicateKey = process.env.REPLICATE_API_KEY;

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    restoreEnv("WAVESPEED_API_KEY", originalKey);
    restoreEnv("LYRIC_ENGINE_API_KEY", originalLyricKey);
    restoreEnv("ENGINE_API_KEY", originalEngineKey);
    restoreEnv("REPLICATE_API_TOKEN", originalReplicateToken);
    restoreEnv("REPLICATE_API_KEY", originalReplicateKey);
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
    expect(url).not.toContain("/v1/");
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
        action: "optimize",
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

    const res = await POST(aiRequest({ action: "optimize", topic: "", lyrics: "", title: "" }));

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

    const pending = POST(aiRequest({ action: "optimize", topic: "neon", title: "Night Drive" }));
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
      const res = await POST(aiRequest({ action: "optimize", topic: "dusk", title: "Porch" }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        success: true,
        title: "Porch",
        lyrics: expected[index],
        result: expected[index],
      });
    }
  });

  function useStyleToken(): void {
    process.env.REPLICATE_API_TOKEN = STYLE_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.LYRIC_ENGINE_API_KEY;
    delete process.env.ENGINE_API_KEY;
    delete process.env.WAVESPEED_API_KEY;
  }

  it("enhances style prompts through Claude Fable and does not call WaveSpeed", async () => {
    useStyleToken();
    const enhanced =
      "Warm acoustic country, 96 BPM, acoustic guitar, brushed snare, close baritone, dry intimate mix";
    const cases = [
      {
        action: "enhance_style",
        body: { prompt: "", lyrics: "", topic: "", text: "" },
        instruction: "Surprise me with a fresh, creative, and commercial music style prompt.",
      },
      {
        action: "enhance_style",
        body: { prompt: "   ", lyrics: "rain on the window", topic: "", text: "" },
        instruction:
          "Analyze these lyrics and create the ideal sonic style prompt to match their tone and cadence:\n\nrain on the window",
      },
      {
        action: "enhance_prompt",
        body: { prompt: "lofi rain", lyrics: "", topic: "ignored topic", text: "ignored text" },
        instruction: 'Expand this style seed into a full production prompt: "lofi rain"',
      },
      {
        action: "generate_style",
        body: { prompt: "", topic: "rock", text: "", lyrics: "hold the light" },
        instruction:
          'Expand this style seed "rock" while matching the mood, meter, and cadence of these lyrics:\n\nhold the light',
      },
      {
        action: "enhance_style",
        body: { prompt: "  ", topic: "dusty country", text: "ignored text" },
        instruction: 'Expand this style seed into a full production prompt: "dusty country"',
      },
      {
        action: "enhance_style",
        body: { prompt: "", topic: " ", text: "harbor fog" },
        instruction: 'Expand this style seed into a full production prompt: "harbor fog"',
      },
    ];

    for (const spec of cases) {
      const fetchMock = vi.fn(async () =>
        jsonResponse({
          id: "style_pred",
          status: "succeeded",
          output: `"${enhanced}"`,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const logs: string[] = [];
      const push = (...args: unknown[]) => {
        logs.push(args.map((part) => String(part)).join(" "));
      };
      vi.spyOn(console, "log").mockImplementation(push);
      vi.spyOn(console, "info").mockImplementation(push);
      vi.spyOn(console, "warn").mockImplementation(push);
      vi.spyOn(console, "error").mockImplementation(push);

      const res = await POST(aiRequest({ action: spec.action, ...spec.body }));

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true, style: enhanced, prompt: enhanced });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(String(url)).toContain(`/models/${STYLE_MODEL}/predictions`);
      expect(String(url)).not.toContain("wavespeed");
      expect(String(url)).not.toContain("gemini");
      expect(String(url)).not.toContain("llama");
      expect(String(url)).not.toContain("haiku");
      const input = (requestBody(fetchMock.mock.calls[0] as unknown[]).input ?? {}) as Record<string, unknown>;
      expect(input.system_prompt).toBe(STYLE_SYSTEM);
      expect(input.prompt).toBe(spec.instruction);
      expect(input.temperature).toBe(0.7);
      expect(input.max_tokens).toBe(1024);
      expect(input.system_instruction).toBeUndefined();
      expect(input.max_output_tokens).toBeUndefined();
      expect(input.max_new_tokens).toBeUndefined();
      const headers = init.headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe(`Bearer ${STYLE_TOKEN}`);
      const logged = logs.join("\n");
      expect(logged).not.toContain(STYLE_TOKEN);
      expect(logged).not.toContain("Authorization");
      expect(logged).not.toContain("Bearer");
      vi.restoreAllMocks();
    }
  });

  it("joins array output from Claude Fable", async () => {
    useStyleToken();
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "style_pred",
        status: "succeeded",
        output: ["Moody ", "alt-pop, 84 BPM, breathy female vocal"],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_prompt", prompt: "moody storm" }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      success: true,
      style: "Moody alt-pop, 84 BPM, breathy female vocal",
      prompt: "Moody alt-pop, 84 BPM, breathy female vocal",
    });
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain(`/models/${STYLE_MODEL}/predictions`);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).not.toContain("wavespeed");
  });

  it("calls Claude for Surprise Me when style and lyrics are empty", async () => {
    useStyleToken();
    process.env.WAVESPEED_API_KEY = "test-key";
    const enhanced = "Neon synthwave, 118 BPM, analog bass, airy female vocal, wide club room";
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "style_pred", status: "succeeded", output: enhanced }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({
        action: "enhance_prompt",
        prompt: "  ",
        topic: "",
        text: "\n",
        lyrics: "   ",
      }),
    );
    const body = (await res.json()) as { success?: boolean; style?: string; prompt?: string; lyrics?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, style: enhanced, prompt: enhanced });
    expect(body.lyrics).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/models/${STYLE_MODEL}/predictions`);
    expect(String(url)).not.toContain("wavespeed");
    const input = (requestBody(fetchMock.mock.calls[0] as unknown[]).input ?? {}) as Record<string, unknown>;
    expect(input.prompt).toBe("Surprise me with a fresh, creative, and commercial music style prompt.");
    expect(input.temperature).toBe(0.7);
    expect(input.max_tokens).toBe(1024);
  });

  it("returns 500 when the replicate token is missing and does not fetch", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    delete process.env.REPLICATE_API_KEY;
    delete process.env.LYRIC_ENGINE_API_KEY;
    delete process.env.ENGINE_API_KEY;
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", prompt: "dark trap" }));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("Missing REPLICATE_API_TOKEN in environment variables.");
    expect(body.error).not.toContain("test-key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the provider error when style enhancement is rejected", async () => {
    useStyleToken();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "model rejected the style" }, 400));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_prompt", prompt: "rainy loft jazz" }));
    const body = (await res.json()) as { error?: string; style?: string; prompt?: string; success?: boolean };

    expect(res.status).toBe(500);
    expect(body.success).not.toBe(true);
    expect(body.style).toBeUndefined();
    expect(body.prompt).toBeUndefined();
    expect(body.error).toContain("model rejected the style");
    expect(body.error).not.toBe("rainy loft jazz");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toContain(`/models/${STYLE_MODEL}/predictions`);
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).not.toContain("wavespeed");
  });

  it("returns 500 when style enhancement is empty or contains section tags", async () => {
    useStyleToken();
    const outputs = ["[Chorus]\nkeep the light on", "[Verse] night rain", "[Intro] thunder", "   ", '""'];

    for (const output of outputs) {
      const fetchMock = vi.fn(async () => jsonResponse({ id: "style_pred", status: "succeeded", output }));
      vi.stubGlobal("fetch", fetchMock);
      const res = await POST(aiRequest({ action: "enhance_style", text: "rain" }));
      const body = (await res.json()) as { error?: string; style?: string; lyrics?: string };

      expect(res.status).toBe(500);
      expect(body.error).toBe("Style enhancement returned an empty prompt.");
      expect(body.style).toBeUndefined();
      expect(body.lyrics).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("keep the light");
      expect(JSON.stringify(body)).not.toContain("night rain");
      expect(JSON.stringify(body)).not.toContain("thunder");
    }
  });

  it("keeps only the first style line when the model adds another paragraph", async () => {
    useStyleToken();
    const firstLine = "Moody alt-pop, 84 BPM, rain piano, breathy female vocal, wide room";
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "style_pred",
        status: "succeeded",
        output: `${firstLine}\n\nA second paragraph that must not be saved.\n[Chorus]\nshould not leak`,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", prompt: "moody late night storm reflection" }));
    const body = (await res.json()) as { success?: boolean; style?: string; prompt?: string; lyrics?: string };

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, style: firstLine, prompt: firstLine });
    expect(body.lyrics).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("second paragraph");
    expect(JSON.stringify(body)).not.toContain("[Chorus]");
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).not.toContain("wavespeed");
  });

  it("writes Claude lyrics without calling WaveSpeed and trims commentary after [Outro]", async () => {
    useStyleToken();
    const kept = [
      "[Verse 1]",
      "Rain taps the window glass",
      "[Chorus]",
      "Hold the light and don't let go",
      "[Outro]",
      "The storm walks out the door",
      "",
      "Lights fade down the lane",
    ].join("\n");
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        id: "lyric_pred",
        status: "succeeded",
        output: `${kept}\n\n\nI hope this fits the vocal engine. Let me know if you want another verse.`,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({
        action: "generate_lyrics",
        topic: "rain",
        prompt: "ignored prompt",
        genre: "dark country",
        title: "Night Drive",
      }),
    );
    const body = (await res.json()) as {
      success?: boolean;
      title?: string;
      lyrics?: string;
      result?: string;
      style?: string;
      prompt?: string;
    };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.lyrics).toBe(kept);
    expect(body.result).toBe(body.lyrics);
    expect(body.title).toBe("Night Drive");
    expect(body.style).toBeUndefined();
    expect(body.prompt).toBeUndefined();
    expect(body.lyrics).toContain("[Outro]");
    expect(body.lyrics).toContain("Lights fade down the lane");
    expect(body.lyrics).not.toContain("I hope this fits");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain(`/models/${STYLE_MODEL}/predictions`);
    expect(String(url)).not.toContain("wavespeed");
    const input = (requestBody(fetchMock.mock.calls[0] as unknown[]).input ?? {}) as Record<string, unknown>;
    expect(input.system_prompt).toBe(LYRIC_SYSTEM_WITH_GENRE);
    expect(input.prompt).toBe('Write complete song lyrics about: "rain"');
    expect(input.temperature).toBe(0.7);
    expect(input.max_tokens).toBe(1024);
  });

  it("returns 500 when Claude lyrics have no section header", async () => {
    useStyleToken();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "lyric_pred", status: "succeeded", output: "just a paragraph with no headers" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "generate_lyrics", topic: "storm" }));
    const body = (await res.json()) as { error?: string; lyrics?: string; style?: string };

    expect(res.status).toBe(500);
    expect(body.error).toBe("Lyric generation returned no sectioned lyrics.");
    expect(body.lyrics).toBeUndefined();
    expect(body.style).toBeUndefined();
    expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).not.toContain("wavespeed");
  });
});
