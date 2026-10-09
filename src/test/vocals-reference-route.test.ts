// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, uploadMock, getPublicUrlMock, fromMock, resolveStudioSessionMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  uploadMock: vi.fn(async () => ({ data: { path: "vocal-references/user/reference.wav" }, error: null })),
  getPublicUrlMock: vi.fn(),
  fromMock: vi.fn(),
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

import { POST } from "@/app/api/vocals/reference/route";

const SESSION_USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const SUPABASE_URL = "https://project.supabase.co";
const MAX_REFERENCE_BYTES = 50 * 1024 * 1024;

function wavBytes(length = 44): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x41, 0x56, 0x45], 8);
  return bytes;
}

function webmBytes(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
}

function uploadRequest(bytes: Uint8Array | null, authorization = "Bearer a.b.c", filename = "Time Is Not My Friend.wav"): Request {
  const form = new FormData();
  if (bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append("audio", new File([copy], filename, { type: "audio/wav" }));
  }
  form.append("userId", OTHER_USER);
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vocals/reference", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/vocals/reference", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    getPublicUrlMock.mockReset();
    getPublicUrlMock.mockImplementation((path: string) => ({
      data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${path}?token=signed-token` },
    }));
    fromMock.mockReset();
    fromMock.mockImplementation(() => ({ upload: uploadMock, getPublicUrl: getPublicUrlMock }));
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => ({
      storage: { from: fromMock },
    }));
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ data: { path: "vocal-references/user/reference.wav" }, error: null });
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

  it("returns 401 without a session and does not upload", async () => {
    const missing = await POST(uploadRequest(wavBytes(), ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("stores a RIFF wav under the session user and returns a public url without a token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(200);
    const objectPath = `vocal-references/${SESSION_USER}/reference-1700000021000.wav`;
    const payload = (await res.json()) as { url: string };
    expect(payload).toEqual({
      url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`,
    });
    expect(payload.url).not.toContain("token=");
    expect(JSON.stringify(payload)).not.toContain("signed-token");
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(fromMock).toHaveBeenCalledWith("audio-vault");
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType?: string; upsert?: boolean },
    ];
    expect(path).toBe(objectPath);
    expect(path).not.toContain(OTHER_USER);
    expect(path).not.toContain("voice-take");
    expect(options).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect((body as Buffer).subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts a wav larger than the 15 MB mic-take limit", async () => {
    const res = await POST(uploadRequest(wavBytes(15 * 1024 * 1024 + 1), "Bearer a.b.c", "large.wav"));
    expect(res.status).toBe(200);
    const [, body] = uploadMock.mock.calls[0] as unknown as [string, Buffer];
    expect(body.length).toBe(15 * 1024 * 1024 + 1);
    expect(body.length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES);
  });

  it("rejects webm and a file over 50 MB", async () => {
    const webm = await POST(uploadRequest(webmBytes(), "Bearer a.b.c", "take.webm"));
    expect(webm.status).toBe(400);
    await expect(webm.json()).resolves.toEqual({ error: "Reference audio must be a WAV file." });
    expect(uploadMock).not.toHaveBeenCalled();

    const rejected = await POST(uploadRequest(wavBytes(MAX_REFERENCE_BYTES + 1), "Bearer a.b.c", "big.wav"));
    expect(rejected.status).toBe(400);
    await expect(rejected.json()).resolves.toEqual({ error: "File empty or exceeds 50MB limit" });
    expect(uploadMock).not.toHaveBeenCalled();
  });
});
