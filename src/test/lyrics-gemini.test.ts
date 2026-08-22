import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/resilient-fetch.server", () => ({
  resilientFetch: vi.fn(),
}));

import { resilientFetch } from "@/lib/resilient-fetch.server";
import { COPRODUCER_GEMINI_MODEL, writeLyrics } from "@/lib/lyrics.server";

const fetchMock = vi.mocked(resilientFetch);

describe("Co-Producer Gemini lyrics via Replicate", () => {
  const originalToken = process.env.REPLICATE_API_TOKEN;
  const originalKey = process.env.REPLICATE_API_KEY;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
    if (originalKey === undefined) delete process.env.REPLICATE_API_KEY;
    else process.env.REPLICATE_API_KEY = originalKey;
    vi.clearAllMocks();
  });

  it("posts to Replicate Gemini with language, title, and genre, then joins the output array", async () => {
    process.env.REPLICATE_API_TOKEN = "test-replicate-token";
    delete process.env.REPLICATE_API_KEY;
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          output: ["[Verse]\nGo\n", "[Chorus]\nHold the line"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const lyrics = await writeLyrics({
      concept: "night drive",
      title: "Night Drive",
      style: "Nu-Metal",
      language: "Lithuanian (Lietuvių)",
    });

    expect(lyrics).toContain("[Verse]");
    expect(lyrics).toContain("[Chorus]\nHold the line");
    expect(COPRODUCER_GEMINI_MODEL).toMatch(/gemini|gemma/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.replicate.com");
    expect(url).toContain(`/models/${COPRODUCER_GEMINI_MODEL}/predictions`);
    expect(url).not.toContain("generativelanguage.googleapis.com");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer test-replicate-token",
    });
    const body = JSON.parse(String(init.body)) as {
      input: {
        prompt: string;
        system_instruction?: string;
        system_prompt?: string;
        max_output_tokens?: number;
      };
    };
    expect(body.input.system_instruction).toContain("expert music lyricist and co-producer");
    expect(body.input.system_instruction).toContain("Lithuanian (Lietuvių)");
    expect(body.input.system_instruction).toContain("Night Drive");
    expect(body.input.prompt).toContain("Genre / style: Nu-Metal");
    expect(body.input.system_prompt).toBeUndefined();
    expect(body.input.max_output_tokens).toBe(4096);
  });
});
