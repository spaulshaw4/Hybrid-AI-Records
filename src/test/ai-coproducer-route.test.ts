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

  it("uses gemini-2.5-flash and max_tokens 1500 when WAVESPEED_LLM_MODEL is unset", async () => {
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
    expect(payload.model).toBe("gemini-2.5-flash");
    expect(payload.temperature).toBe(0.7);
    expect(payload.max_tokens).toBe(1500);
    expect(payload.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(payload.messages[1]?.content).toContain("dark trap");
  });

  it("sends the optimize prompts and gemini-2.5-flash by default", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "  [Verse]\nkept line  " } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      aiRequest({ action: "optimize", lyrics: "line one", title: "Night", prompt: "dark trap", topic: "rain" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, result: "[Verse]\nkept line" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(payload.model).toBe("gemini-2.5-flash");
    expect(payload.temperature).toBe(0.7);
    expect(payload.max_tokens).toBe(1500);
    expect(payload.messages[0]?.content).toBe(
      "You are an elite lyricist and vocal arranger. Optimize these lyrics to improve musical meter, natural syllable stress, and rhyme schemes while keeping the original meaning and structure intact. Return only the raw lyrics with structural tags ([Verse], [Chorus], etc.).",
    );
    expect(payload.messages[1]?.content).toBe('Title: "Night"\n\nCurrent Lyrics:\nline one');
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
    expect(payload.max_tokens).toBe(1500);
  });

  it("forwards an upstream error status and message", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "quota exceeded" } }, 429));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", text: "dark trap", title: "Night" }));

    expect(res.status).toBe(429);
    await expect(res.json()).resolves.toEqual({ error: "WaveSpeed LLM Error: quota exceeded" });
  });

  it("prefixes a top-level upstream message when error.message is absent", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ message: "model not found" }, 502));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "optimize", lyrics: "line one", title: "Night" }));

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toEqual({ error: "WaveSpeed LLM Error: model not found" });
  });

  it("uses the rejection fallback when the upstream body has no message", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "enhance_style", text: "dark trap" }));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "WaveSpeed LLM Error: WaveSpeed LLM request rejected.",
    });
  });

  it("returns 400 for an unknown action and does not call upstream", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(aiRequest({ action: "rewrite_mix", text: "dark trap" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Unknown action" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends enhance_match_vibe at temperature 0.6 and falls back when text is empty", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "  polished grunge  " } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const filled = await POST(aiRequest({ action: "enhance_match_vibe", text: "dark trap", title: "Night" }));
    expect(filled.status).toBe(200);
    await expect(filled.json()).resolves.toEqual({ success: true, result: "polished grunge" });

    const empty = await POST(aiRequest({ action: "enhance_match_vibe", text: "", title: "" }));
    expect(empty.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    });

    for (const payload of payloads) {
      expect(payload.model).toBe("gemini-2.5-flash");
      expect(payload.model).not.toBe("gemini-3.5-flash");
      expect(payload.temperature).toBe(0.6);
      expect(payload.max_tokens).toBe(1000);
      expect(payload.messages[0]?.content).toBe(
        "You are an elite studio producer prompt engineer for Mureka v9.5. Take the user's style idea and polish/expand it into a dense, production-grade prompt under 800 characters. Preserve their exact genre, tempo, and vibe. Explicitly define rhythm section instruments, acoustic vs electric balance, drum dynamics, and vocal timbre. Return only the prompt.",
      );
    }
    expect(payloads[0]?.messages[1]?.content).toBe('Polish and expand this style: "dark trap"');
    expect(payloads[1]?.messages[1]?.content).toBe('Polish and expand this style: "Heavy acoustic grunge rock"');
  });

  it("sends enhance_surprise_me at temperature 0.9 and falls back when text is empty", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "twisted hybrid" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const filled = await POST(aiRequest({ action: "enhance_surprise_me", text: "Acoustic folk", title: "Night" }));
    expect(filled.status).toBe(200);
    await expect(filled.json()).resolves.toEqual({ success: true, result: "twisted hybrid" });

    const empty = await POST(aiRequest({ action: "enhance_surprise_me", text: "" }));
    expect(empty.status).toBe(200);

    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    });

    for (const payload of payloads) {
      expect(payload.model).toBe("gemini-2.5-flash");
      expect(payload.temperature).toBe(0.9);
      expect(payload.max_tokens).toBe(1000);
      expect(payload.messages[0]?.content).toBe(
        "You are an avant-garde record producer for Mureka v9.5. Take the user's style concept and introduce a fresh, unexpected twist or genre fusion under 800 characters. Inject distinctive textures (e.g., brooding cello, swampy resonator slide, retro tape warmth, dramatic halftime drops) while maintaining high-energy musicality. Return only the prompt.",
      );
    }
    expect(payloads[0]?.messages[1]?.content).toBe('Give this style an unexpected twist: "Acoustic folk"');
    expect(payloads[1]?.messages[1]?.content).toBe('Give this style an unexpected twist: "Acoustic rock"');
  });

  it("keeps lyric workshop actions on their existing prompts, temperature 0.7, and max_tokens 1500", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "workshop line" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const cases = [
      {
        body: {
          action: "section",
          lyrics: "raw line from lyrics",
          text: "ignore this text field",
          title: "Night",
          prompt: "dark trap",
          topic: "rain",
        },
        system:
          "You are a music producer. Analyze these lyrics and insert proper structural tags where appropriate ([Intro], [Verse 1], [Pre-Chorus], [Chorus], [Verse 2], [Bridge], [Outro]). Do not change the wording; only add or clean up the section markers.",
        user: "raw line from lyrics",
      },
      {
        body: {
          action: "next_line",
          lyrics: "existing couplet",
          text: "ignore this text field",
          title: "Night",
          prompt: "dark trap",
          topic: "rain",
        },
        system:
          "You are an expert songwriter. Read the lyrics and write the immediate next 2 to 4 lines that naturally follow in tone, meter, rhyme, and emotional progression. Return only the new lines to append.",
        user: 'Song Title: "Night"\nExisting lines:\nexisting couplet',
      },
      {
        body: {
          action: "generate_topic",
          lyrics: "unused draft",
          text: "ignore this text field",
          title: "Night",
          prompt: "dark trap",
          topic: "rain on the roof",
        },
        system:
          "You are an elite songwriter. Write a complete, evocative song lyric sheet with [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], and [Outro]. Return only the formatted lyrics.",
        user: 'Song Title: "Night"\nStyle: "dark trap"\nTheme or Story: "rain on the roof"',
      },
    ];

    for (const entry of cases) {
      const res = await POST(aiRequest(entry.body));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ success: true, result: "workshop line" });
    }

    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    });

    cases.forEach((entry, index) => {
      const payload = payloads[index];
      expect(payload?.model).toBe("gemini-2.5-flash");
      expect(payload?.temperature).toBe(0.7);
      expect(payload?.max_tokens).toBe(1500);
      expect(payload?.messages[0]?.content).toBe(entry.system);
      expect(payload?.messages[1]?.content).toBe(entry.user);
      expect(payload?.messages[1]?.content).not.toContain("ignore this text field");
    });
  });

  it("sends optimize_lyrics and generate_lyrics from the text field at temperature 0.6", async () => {
    process.env.WAVESPEED_API_KEY = "test-key";
    delete process.env.WAVESPEED_LLM_MODEL;
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "lyric sheet" } }] }));
    vi.stubGlobal("fetch", fetchMock);

    const optimized = await POST(
      aiRequest({ action: "optimize_lyrics", text: "[Verse]\nloose line", lyrics: "do not use lyrics field", title: "Night" }),
    );
    expect(optimized.status).toBe(200);
    await expect(optimized.json()).resolves.toEqual({ success: true, result: "lyric sheet" });

    const generated = await POST(aiRequest({ action: "generate_lyrics", text: "", title: "" }));
    expect(generated.status).toBe(200);

    const payloads = fetchMock.mock.calls.map((call) => {
      const init = call[1] as RequestInit;
      return JSON.parse(String(init.body)) as {
        model: string;
        temperature: number;
        max_tokens: number;
        messages: Array<{ role: string; content: string }>;
      };
    });

    expect(payloads[0]?.model).toBe("gemini-2.5-flash");
    expect(payloads[0]?.temperature).toBe(0.6);
    expect(payloads[0]?.max_tokens).toBe(1000);
    expect(payloads[0]?.messages[0]?.content).toBe(
      "You are an elite lyricist. Refine these lyrics to tighten meter, cadence, and structure tags ([Verse], [Chorus], [Bridge], [Outro]). Return only the lyrics.",
    );
    expect(payloads[0]?.messages[1]?.content).toBe("Optimize these lyrics:\n\n[Verse]\nloose line");
    expect(payloads[0]?.messages[1]?.content).not.toContain("do not use lyrics field");

    expect(payloads[1]?.temperature).toBe(0.6);
    expect(payloads[1]?.max_tokens).toBe(1000);
    expect(payloads[1]?.messages[0]?.content).toBe(
      "You are an elite lyricist. Write a complete song lyric sheet with [Verse 1], [Chorus], [Verse 2], [Chorus], [Bridge], and [Outro]. Return only the lyrics.",
    );
    expect(payloads[1]?.messages[1]?.content).toBe(
      'Write complete song lyrics titled "Untitled" in this style: "Heavy acoustic rock"',
    );
  });
});
