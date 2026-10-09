// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveStudioSessionMock } = vi.hoisted(() => ({
  resolveStudioSessionMock: vi.fn(),
}));

vi.mock("@/lib/studio-request-auth.server", () => ({
  resolveStudioSession: (...args: unknown[]) => resolveStudioSessionMock(...args),
  UnauthorizedSessionError: class UnauthorizedSessionError extends Error {
    status = 401;
    constructor(message = "Unauthorized session") {
      super(message);
      this.name = "UnauthorizedSessionError";
    }
  },
}));

import { POST } from "@/app/api/reference/audio-to-prompt/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "r8_test_token_do_not_log";
const SUPABASE_URL = "https://project.supabase.co";
const CLIENT_ERROR = "Failed to analyze reference audio";
const ANALYSIS_PROMPT = `Listen to this master audio track closely.
Extract its core acoustic and production DNA.
Return ONLY valid JSON matching this schema:
{
  "tags": "BPM, key musical key, primary instrumentation, rhythmic groove, vocal texture (max 100 characters)"
}`;

function publicAudioUrl(userId = SESSION_USER, name = "take.wav"): string {
  return `${SUPABASE_URL}/storage/v1/object/public/audio-vault/references/${userId}/1700000021000-${name}`;
}

function jsonRequest(body: unknown, authorization = "Bearer session-token"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/reference/audio-to-prompt", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/reference/audio-to-prompt", () => {
  const originalToken = process.env.REPLICATE_API_TOKEN;
  const originalPublicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalSupabaseUrl = process.env.SUPABASE_URL;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = TOKEN;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_URL = SUPABASE_URL;
    resolveStudioSessionMock.mockReset();
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalPublicUrl;
    if (originalSupabaseUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalSupabaseUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is mounted from the studio server", () => {
    const source = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    expect(source).toContain('pathname === "/api/reference/audio-to-prompt"');
    expect(source).toContain('import("./app/api/reference/audio-to-prompt/route")');
    const route = readFileSync(join(process.cwd(), "src/app/api/reference/audio-to-prompt/route.ts"), "utf8");
    expect(route).not.toContain("maxDuration");
    expect(route).not.toContain("NextRequest");
    expect(route).not.toContain("NextResponse");
    expect(route).not.toContain('from "replicate"');
    expect(route).not.toContain("replicate.run");
    expect(route).toContain(ANALYSIS_PROMPT);
  });

  it("returns 401 without a bearer and ignores a body userId", async () => {
    const audioUrl = publicAudioUrl();
    const missing = await POST(jsonRequest({ audioUrl, userId: OTHER_USER }, ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));
    const rejected = await POST(jsonRequest({ audioUrl, userId: OTHER_USER }));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when audioUrl is missing", async () => {
    const missing = await POST(jsonRequest({ userId: OTHER_USER }));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Missing audioUrl" });

    const empty = await POST(jsonRequest({ audioUrl: "  ", userId: SESSION_USER }));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ error: "Missing audioUrl" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for http, signed, link-local, and foreign hosts", async () => {
    const rejected = [
      publicAudioUrl().replace("https://", "http://"),
      `${SUPABASE_URL}/storage/v1/object/sign/audio-vault/references/${SESSION_USER}/1700000021000-take.wav`,
      `https://169.254.169.254/storage/v1/object/public/audio-vault/references/${SESSION_USER}/take.wav`,
      `https://localhost/storage/v1/object/public/audio-vault/references/${SESSION_USER}/take.wav`,
      `https://evil.example/storage/v1/object/public/audio-vault/references/${SESSION_USER}/take.wav`,
      publicAudioUrl(OTHER_USER),
      `${publicAudioUrl()}?token=fixture`,
    ];
    for (const audioUrl of rejected) {
      const response = await POST(jsonRequest({ audioUrl, userId: OTHER_USER }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: CLIENT_ERROR });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("sends the public url as input.audio with the exact prompt", async () => {
    const audioUrl = publicAudioUrl();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          output: ["```JSON\n", JSON.stringify({ tags: " driving rock, analog synth " }), "\n```"],
        }),
        { status: 201 },
      ),
    );

    const response = await POST(jsonRequest({ audioUrl, userId: OTHER_USER }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean; tags?: string; error?: string };
    expect(body).toEqual({ success: true, tags: "driving rock, analog synth" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/replicate|gemini|claude|wavespeed|supabase/i);
    expect(JSON.stringify(body)).not.toContain("data:");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("prefer")).toBe("wait");
    const sent = JSON.parse(String(init.body)) as {
      input: { prompt: string; audio: string; file?: string; files?: string[] };
      userId?: string;
    };
    expect(sent.userId).toBeUndefined();
    expect(sent.input.prompt).toBe(ANALYSIS_PROMPT);
    expect(sent.input.audio).toBe(audioUrl);
    expect(sent.input.file).toBeUndefined();
    expect(sent.input.files).toBeUndefined();
    expect(sent.input.audio).toContain("/storage/v1/object/public/audio-vault/references/");
    expect(sent.input.audio).toContain(`/references/${SESSION_USER}/`);
    expect(sent.input.audio).not.toContain("/object/sign/");
    expect(String(init.body)).not.toContain("data:");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns 500 without the upstream message when analysis fails", async () => {
    const audioUrl = publicAudioUrl();
    delete process.env.REPLICATE_API_TOKEN;
    const missingToken = await POST(jsonRequest({ audioUrl }));
    expect(missingToken.status).toBe(500);
    await expect(missingToken.json()).resolves.toEqual({ error: CLIENT_ERROR });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.REPLICATE_API_TOKEN = TOKEN;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "failed", detail: TOKEN }), { status: 500 }));
    const upstream = await POST(jsonRequest({ audioUrl }));
    expect(upstream.status).toBe(500);
    const upstreamBody = await upstream.json();
    expect(upstreamBody).toEqual({ error: CLIENT_ERROR });
    expect(JSON.stringify(upstreamBody)).not.toContain(TOKEN);
    expect(JSON.stringify(upstreamBody)).not.toMatch(/replicate|gemini/i);

    const logged = vi
      .mocked(console.error)
      .mock.calls.map((parts) => parts.map((part) => String(part)).join(" "))
      .join("\n");
    expect(logged).toContain("[audio-to-prompt] execution failed:");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(audioUrl);
    expect(logged).not.toContain("data:");
  });
});
