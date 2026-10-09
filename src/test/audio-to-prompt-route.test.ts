// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveStudioSessionMock, uploadMock, getPublicUrlMock, storageFromMock, vaultAdminClientMock } = vi.hoisted(
  () => ({
    resolveStudioSessionMock: vi.fn(),
    uploadMock: vi.fn(
      async (): Promise<{ data: { path: string } | null; error: { message?: string } | null }> => ({
        data: { path: "references/user/file.wav" },
        error: null,
      }),
    ),
    getPublicUrlMock: vi.fn(),
    storageFromMock: vi.fn(),
    vaultAdminClientMock: vi.fn(),
  }),
);

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

vi.mock("@/lib/vault-admin.server", () => ({
  vaultAdminClient: (...args: unknown[]) => vaultAdminClientMock(...args),
}));

import { POST } from "@/app/api/reference/audio-to-prompt/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "r8_test_token_do_not_log";
const SUPABASE_URL = "https://project.supabase.co";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;
const STAMP = 1_700_000_021_000;
const ANALYSIS_PROMPT = `Listen to this master audio track closely.
Extract its core acoustic and production DNA.
Return ONLY valid JSON matching this schema:
{
  "tags": "BPM, key musical key, primary instrumentation, rhythmic groove, vocal texture (max 100 characters)"
}`;

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

function fileBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
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
    form.append(field, new File([fileBytes(bytes)], filename, { type: mime }));
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

function objectPath(safeName: string): string {
  return `references/${SESSION_USER}/${STAMP}-${safeName}`;
}

function publicUrl(safeName: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath(safeName)}`;
}

describe("POST /api/reference/audio-to-prompt", () => {
  const originalToken = process.env.REPLICATE_API_TOKEN;
  const fetchMock = vi.fn();

  beforeEach(() => {
    process.env.REPLICATE_API_TOKEN = TOKEN;
    resolveStudioSessionMock.mockReset();
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ data: { path: "references/user/file.wav" }, error: null });
    getPublicUrlMock.mockReset();
    getPublicUrlMock.mockImplementation((path: string) => ({
      data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${path}?token=signed-token` },
    }));
    storageFromMock.mockReset();
    storageFromMock.mockImplementation(() => ({ upload: uploadMock, getPublicUrl: getPublicUrlMock }));
    vaultAdminClientMock.mockReset();
    vaultAdminClientMock.mockImplementation(() => ({ storage: { from: storageFromMock } }));
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(STAMP);
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
    expect(uploadMock).not.toHaveBeenCalled();

    resolveStudioSessionMock.mockRejectedValue(new Error("Unauthorized session"));
    const rejected = await POST(analyzeRequest(wavBytes()));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("returns 400 for a missing file, webm, and an oversized wav", async () => {
    const missing = await POST(analyzeRequest(null));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "Missing audio file" });

    const wrongField = await POST(analyzeRequest(wavBytes(), "Bearer session-token", "take.wav", "audio", "audio/wav"));
    expect(wrongField.status).toBe(400);
    await expect(wrongField.json()).resolves.toEqual({ error: "Missing audio file" });

    const webm = await POST(analyzeRequest(webmBytes(), "Bearer session-token", "take.webm", "file", "audio/wav"));
    expect(webm.status).toBe(400);
    await expect(webm.json()).resolves.toEqual({ error: "Reference audio must be a WAV file." });

    const oversized = await POST(analyzeRequest(wavBytes(MAX_REFERENCE_BYTES + 1)));
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ error: "File empty or exceeds 50MB limit" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("stores a sniffed wav and sends the public https url as audio", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "succeeded",
          output: ["```json\n", JSON.stringify({ tags: " driving rock, analog synth " }), "\n```"],
        }),
        { status: 201 },
      ),
    );

    const response = await POST(
      analyzeRequest(wavBytes(), "Bearer session-token", "Time Is Not My Friend.wav", "file", "audio/webm"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { success?: boolean; tags?: string; filename?: string; error?: string };
    expect(body).toEqual({
      success: true,
      tags: "driving rock, analog synth",
      filename: "Time Is Not My Friend.wav",
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(body)).not.toMatch(/replicate|gemini|claude|wavespeed|supabase/i);
    expect(JSON.stringify(body)).not.toContain("data:");

    expect(storageFromMock).toHaveBeenCalledWith("audio-vault");
    const [path, uploaded, options] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType?: string; upsert?: boolean },
    ];
    expect(path).toBe(objectPath("Time_Is_Not_My_Friend.wav"));
    expect(path.startsWith(`references/${SESSION_USER}/`)).toBe(true);
    expect(path.endsWith(".wav")).toBe(true);
    expect(path).not.toContain(OTHER_USER);
    expect(Buffer.isBuffer(uploaded)).toBe(true);
    expect(uploaded).not.toBeInstanceOf(Blob);
    expect((uploaded as Buffer).subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(options).toEqual({ contentType: "audio/wav", upsert: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.replicate.com/v1/models/google/gemini-3.5-flash/predictions");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("prefer")).toBe("wait");
    const sent = JSON.parse(String(init.body)) as {
      input: { prompt: string; audio: string; images?: string[]; videos?: string[] };
      userId?: string;
    };
    expect(sent.userId).toBeUndefined();
    expect(sent.input.prompt).toBe(ANALYSIS_PROMPT);
    expect(sent.input.videos).toBeUndefined();
    expect(sent.input.images).toBeUndefined();
    expect(sent.input.audio).toBe(publicUrl("Time_Is_Not_My_Friend.wav"));
    expect(sent.input.audio.startsWith("https://")).toBe(true);
    expect(sent.input.audio).toContain("/audio-vault/references/");
    expect(sent.input.audio).toContain(`/references/${SESSION_USER}/`);
    expect(sent.input.audio).not.toContain("token=");
    expect(String(init.body)).not.toContain("data:");
    expect(console.error).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "succeeded", output: [JSON.stringify({ tags: "close vocal, dry" })] }), {
        status: 200,
      }),
    );
    const mpeg = await POST(analyzeRequest(id3Bytes(), "Bearer session-token", "clip.wav", "file", "audio/wav"));
    expect(mpeg.status).toBe(200);
    const mpegUpload = uploadMock.mock.calls[1] as unknown as [string, unknown, { contentType?: string; upsert?: boolean }];
    expect(mpegUpload[0]).toBe(objectPath("clip.mp3"));
    expect(mpegUpload[0].endsWith(".mp3")).toBe(true);
    expect(mpegUpload[0].endsWith(".wav")).toBe(false);
    expect(mpegUpload[2]).toEqual({ contentType: "audio/mpeg", upsert: true });
    expect(Buffer.isBuffer(mpegUpload[1])).toBe(true);
    const mpegSent = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body)) as {
      input: { audio: string };
    };
    expect(mpegSent.input.audio).toBe(publicUrl("clip.mp3"));
    expect(mpegSent.input.audio).toContain("/audio-vault/references/");
    expect(mpegSent.input.audio).not.toContain("data:");
  });

  it("returns 500 when the token is missing, upload fails, or the upstream call fails", async () => {
    delete process.env.REPLICATE_API_TOKEN;
    const missingToken = await POST(analyzeRequest(wavBytes()));
    expect(missingToken.status).toBe(500);
    await expect(missingToken.json()).resolves.toEqual({ error: "Failed to analyze audio" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();

    process.env.REPLICATE_API_TOKEN = TOKEN;
    uploadMock.mockResolvedValueOnce({ data: null, error: { message: TOKEN } });
    const uploadFailed = await POST(analyzeRequest(wavBytes()));
    expect(uploadFailed.status).toBe(500);
    await expect(uploadFailed.json()).resolves.toEqual({ error: "Failed to analyze audio" });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ status: "failed", detail: TOKEN }), { status: 500 }));
    const upstream = await POST(analyzeRequest(wavBytes()));
    expect(upstream.status).toBe(500);
    const upstreamBody = await upstream.json();
    expect(upstreamBody).toEqual({ error: "Failed to analyze audio" });
    expect(JSON.stringify(upstreamBody)).not.toContain(TOKEN);
    const logged = vi.mocked(console.error).mock.calls.flat().map((part) => String(part)).join("\n");
    expect(logged).toBe("[audio-to-prompt] error\n[audio-to-prompt] error\n[audio-to-prompt] error");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain("data:");
    expect(logged).not.toContain("RIFF");
  });
});
