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

import { POST } from "@/app/api/reference/visual-injection/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "r8_test_token_do_not_log";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const VISUAL_PROMPT = `Analyze this image's mood, color palette, and narrative.
Generate a complete song configuration matching its atmosphere.
Return ONLY valid JSON matching this schema:
{
  "title": "Impactful 2-4 word title",
  "tags": "Comma-separated genre, BPM, key instruments, vocal style (max 120 chars)",
  "lyrics": "Complete song lyrics with bracketed markers [Verse 1], [Chorus], [Verse 2], [Bridge], [Outro]"
}`;

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
}

function jpegBytes(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
}

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes;
}

function imageRequest(
  bytes: Uint8Array | null,
  authorization = "Bearer session-token",
  filename = "cover.png",
  mime = "image/gif",
): Request {
  const form = new FormData();
  if (bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append("file", new File([copy], filename, { type: mime }));
  }
  form.append("userId", OTHER_USER);
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/reference/visual-injection", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/reference/visual-injection", () => {
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
    expect(source).toContain('pathname === "/api/reference/visual-injection"');
    expect(source).toContain('import("./app/api/reference/visual-injection/route")');
  });

  it("returns 401 without a bearer and ignores a form userId", async () => {
    const missing = await POST(imageRequest(pngBytes(), ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));
    const rejected = await POST(imageRequest(pngBytes()));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing file, a non-image, and an oversized image", async () => {
    const missing = await POST(imageRequest(null));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Missing image file" });

    const empty = await POST(imageRequest(new Uint8Array()));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ error: "File empty or exceeds 10MB limit" });

    const wav = await POST(imageRequest(wavBytes(), "Bearer session-token", "take.wav", "image/png"));
    expect(wav.status).toBe(400);
    await expect(wav.json()).resolves.toEqual({ error: "Image must be PNG, JPEG, or WebP." });

    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(pngBytes());
    const tooBig = await POST(imageRequest(oversized));
    expect(tooBig.status).toBe(400);
    await expect(tooBig.json()).resolves.toEqual({ error: "File empty or exceeds 10MB limit" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps a mocked prediction onto images and keeps the token out of the response", async () => {
    const song = {
      title: "Glass Harbor",
      tags: "amber rock, 96 bpm, analog synth",
      lyrics: "[Verse 1]\nhello line\n[Chorus]\nhold on",
    };
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          output: ["```json\n", JSON.stringify(song), "\n```"],
        }),
        { status: 201 },
      ),
    );

    const response = await POST(imageRequest(pngBytes(), "Bearer session-token", "cover.png", "image/gif"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ success: true, filename: "cover.png", ...song });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/replicate|gemini|claude|wavespeed|supabase/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("prefer")).toBe("wait");
    const sent = JSON.parse(String(init.body)) as {
      input: { prompt: string; images: string[]; image?: string; videos?: string[] };
      userId?: string;
    };
    expect(sent.userId).toBeUndefined();
    expect(sent.input.prompt).toBe(VISUAL_PROMPT);
    expect(sent.input.image).toBeUndefined();
    expect(sent.input.images).toHaveLength(1);
    expect(sent.input.images[0].startsWith("data:image/png;base64,")).toBe(true);
    expect(console.error).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "succeeded", output: [JSON.stringify(song)] }), { status: 200 }),
    );
    const jpeg = await POST(imageRequest(jpegBytes(), "Bearer session-token", "cover.jpg", "image/png"));
    expect(jpeg.status).toBe(200);
    const jpegSent = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
      input: { images: string[] };
    };
    expect(jpegSent.input.images[0].startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("returns 500 when the token is missing or the output cannot be read", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    const missingToken = await POST(imageRequest(pngBytes()));
    expect(missingToken.status).toBe(500);
    await expect(missingToken.json()).resolves.toEqual({ error: "Failed to process visual injection" });
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.REPLICATE_API_TOKEN = TOKEN;
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "failed", detail: TOKEN }), { status: 500 }));
    const upstream = await POST(imageRequest(pngBytes()));
    expect(upstream.status).toBe(500);
    const upstreamBody = await upstream.json();
    expect(upstreamBody).toEqual({ error: "Failed to process visual injection" });
    expect(JSON.stringify(upstreamBody)).not.toContain(TOKEN);
    const logged = vi.mocked(console.error).mock.calls.flat().map((part) => String(part)).join("\n");
    expect(logged).toBe("[visual-injection] error\n[visual-injection] error");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("data:image");
  });
});
