import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, uploadMock, resolveStudioSessionMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  uploadMock: vi.fn(async (..._args: unknown[]) => ({ data: { path: "vocal-references/user/take.wav" }, error: null })),
  resolveStudioSessionMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
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

import { POST } from "@/app/api/vocals/upload/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SUPABASE_URL = "https://project.supabase.co";

function wavBytes(): Uint8Array {
  const bytes = new Uint8Array(44);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes;
}

function webmBytes(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
}

function uploadRequest(
  bytes: Uint8Array | null,
  authorization = "Bearer a.b.c",
  filename = "take.wav",
  type = "audio/wav",
): Request {
  const boundary = "----vocalboundary";
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  if (bytes) {
    chunks.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
      ),
    );
    chunks.push(bytes);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(
    encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="userId"\r\n\r\n${OTHER_USER}\r\n`),
  );
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const headers = new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vocals/upload", {
    method: "POST",
    headers,
    body,
  });
}

describe("POST /api/vocals/upload", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => ({
      storage: { from: () => ({ upload: uploadMock }) },
    }));
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ data: { path: "vocal-references/user/take.wav" }, error: null });
    resolveStudioSessionMock.mockReset();
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_021_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  });

  it("is mounted ahead of vocal generate", () => {
    const source = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    const uploadAt = source.indexOf('pathname === "/api/vocals/upload"');
    const generateAt = source.indexOf('pathname === "/api/vocals/generate"');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(generateAt).toBeGreaterThan(uploadAt);
  });

  it("returns 401 without a session and does not upload", async () => {
    const missing = await POST(uploadRequest(wavBytes(), ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized session" });

    resolveStudioSessionMock.mockRejectedValue(
      Object.assign(new Error("Unauthorized session"), { name: "UnauthorizedSessionError", status: 401 }),
    );
    const rejected = await POST(uploadRequest(wavBytes()));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized session" });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("stores wav bytes with the service role and returns the public audio-vault url", async () => {
    const wav = wavBytes();
    const res = await POST(uploadRequest(wav, "Bearer a.b.c", "take.webm", "audio/webm"));
    expect(res.status).toBe(200);
    const fileName = "voice-take-1700000021000.wav";
    const objectPath = `vocal-references/${SESSION_USER}/${fileName}`;
    await expect(res.json()).resolves.toEqual({
      url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`,
      fileName,
    });
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [string, Uint8Array, { contentType?: string }];
    expect(path).toBe(objectPath);
    expect(path).not.toContain(OTHER_USER);
    expect(options).toMatchObject({ contentType: "audio/wav", upsert: false });
    expect(body[0]).toBe(0x52);
    expect(body[8]).toBe(0x57);
  });

  it("keeps webm bytes as audio/webm", async () => {
    const res = await POST(uploadRequest(webmBytes(), "Bearer a.b.c", "take.wav", "audio/wav"));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { url: string; fileName: string };
    expect(payload.fileName).toBe("voice-take-1700000021000.webm");
    expect(payload.url).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/voice-take-1700000021000.webm`,
    );
    const [, , options] = uploadMock.mock.calls[0] as unknown as [string, Uint8Array, { contentType?: string }];
    expect(options.contentType).toBe("audio/webm");
    expect(options.contentType).not.toBe("audio/wav");
  });

  it("rejects an empty file, a non-audio file, and a file over 15 MB", async () => {
    const empty = await POST(uploadRequest(new Uint8Array(), "Bearer a.b.c", "empty.wav", "audio/wav"));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ error: "Audio file is empty." });

    const text = await POST(uploadRequest(new Uint8Array([1, 2, 3, 4]), "Bearer a.b.c", "note.txt", "text/plain"));
    expect(text.status).toBe(400);
    await expect(text.json()).resolves.toEqual({ error: "Upload an audio file." });

    const oversized = await POST(
      uploadRequest(new Uint8Array(15 * 1024 * 1024 + 1), "Bearer a.b.c", "big.wav", "audio/wav"),
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ error: "That vocal take is too large." });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
