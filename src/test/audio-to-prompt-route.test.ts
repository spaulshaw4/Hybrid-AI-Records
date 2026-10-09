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
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const ANALYSIS_PROMPT =
  "You are an executive music producer for Hybrid AI Records. Analyze this audio recording and extract its musical DNA. Return ONLY a comma-separated list of: 1. Primary genre and subgenres 2. Key instruments (e.g. analog synth, heavy distorted bass, brass section) 3. Estimated tempo/rhythm feel (e.g. driving mid-tempo, 120 bpm) 4. Production mix aesthetic (e.g. tube saturation, wide stereo field, dry punchy drums) 5. Vocal profile if present (e.g. soaring rock tenor, soulful female alto) Keep the entire output under 150 characters, formatted strictly as plain text tags without bullet points or introductory commentary.";

function wavBytes(length = 44): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  if (length >= 12) bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes;
}

function webmBytes(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
}

function id3Bytes(): Uint8Array {
  return new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);
}

function analyzeRequest(
  bytes: Uint8Array | null,
  authorization = "Bearer session-token",
  filename = "Time Is Not My Friend.wav",
  field: "file" | "audio" = "file",
  mime = "audio/webm",
): Request {
  const form = new FormData();
  if (bytes) {
    form.append(field, new File([bytes], filename, { type: mime }));
  }
  form.append("userId", OTHER_USER);
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/reference/audio-to-prompt", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/reference/audio-to-prompt", () => {
  const originalToken = process.env.REPLICATE_API_TOKEN;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = TOKEN;
    resolveStudioSessionMock.mockReset();
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = originalToken;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("is mounted from the studio server", () => {
    const source = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    expect(source).toContain('pathname === "/api/reference/audio-to-prompt"');
    expect(source).toContain('import("./app/api/reference/audio-to-prompt/route")');
  });

  it("returns 401 without a bearer and ignores a form userId", async () => {
    const missing = await POST(analyzeRequest(wavBytes(), ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));
    const rejected = await POST(analyzeRequest(wavBytes()));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing file, webm, and an oversized wav", async () => {
    const missing = await POST(analyzeRequest(null));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "No audio file provided" });

    const webm = await POST(analyzeRequest(webmBytes(), "Bearer session-token", "take.webm", "file", "audio/wav"));
    expect(webm.status).toBe(400);
    await expect(webm.json()).resolves.toEqual({ error: "Reference audio must be a WAV file." });

    const oversized = await POST(analyzeRequest(wavBytes(MAX_REFERENCE_BYTES + 1)));
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ error: "File empty or exceeds 50MB limit" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a mocked prediction to tags and keeps the token out of the response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "succeeded", output: [" driving rock, ", "analog synth "] }), {
        status: 201,
      }),
    );

    const response = await POST(analyzeRequest(wavBytes(), "Bearer session-token", "Time Is Not My Friend.wav", "file", "audio/webm"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean; tags?: string; filename?: string; error?: string };
    expect(body).toEqual({
      success: true,
      tags: "driving rock, analog synth",
      filename: "Time Is Not My Friend.wav",
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/replicate|gemini|claude|wavespeed|supabase/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("prefer")).toBe("wait");
    const sent = JSON.parse(String(init.body)) as { input: { prompt: string; audio: string; videos?: string[] }; userId?: string };
    expect(sent.userId).toBeUndefined();
    expect(sent.input.prompt).toBe(ANALYSIS_PROMPT);
    expect(sent.input.videos).toBeUndefined();
    expect(sent.input.audio.startsWith("data:audio/wav;base64,")).toBe(true);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("returns 500 when the token is missing or the upstream call fails", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    const missingToken = await POST(analyzeRequest(wavBytes()));
    expect(missingToken.status).toBe(500);
    await expect(missingToken.json()).resolves.toEqual({ error: "Failed to analyze audio" });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.REPLICATE_API_TOKEN = TOKEN;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "failed", detail: TOKEN }), { status: 500 }));
    const upstream = await POST(analyzeRequest(id3Bytes(), "Bearer session-token", "clip.mp3", "audio", "audio/mpeg"));
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      input: { audio: string };
    };
    expect(sent.input.audio.startsWith("data:audio/mpeg;base64,")).toBe(true);
    expect(upstream.status).toBe(500);
    const upstreamBody = await upstream.json();
    expect(upstreamBody).toEqual({ error: "Failed to analyze audio" });
    expect(JSON.stringify(upstreamBody)).not.toContain(TOKEN);
    const logged = vi.mocked(console.error).mock.calls.flat().map((part) => String(part)).join("\n");
    expect(logged).toBe("[audio-to-prompt] analysis failed\n[audio-to-prompt] analysis failed");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("data:audio");
  });
});
