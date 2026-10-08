// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, uploadMock, getPublicUrlMock, fromMock, resolveStudioSessionMock, personaInsertMock, fetchMock } =
  vi.hoisted(() => ({
    createClientMock: vi.fn(),
    uploadMock: vi.fn(
      async (..._args: unknown[]): Promise<{ data: { path: string } | null; error: { message: string } | null }> => ({
        data: { path: "vocal-references/user/take.wav" },
        error: null,
      }),
    ),
    getPublicUrlMock: vi.fn(),
    fromMock: vi.fn(),
    resolveStudioSessionMock: vi.fn(),
    personaInsertMock: vi.fn(async () => ({ error: null })),
    fetchMock: vi.fn(),
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
const VOICE_TASK = "voice-task-1";
const WEBHOOK_SECRET = "test-webhook-secret-fixed";
const VOCAL_KEY = "test-vocal-key";
const CREATE_VOICE_URL = "https://api.aimusicapi.ai/api/v1/sonic/create-voice";
const MUSIC_WEBHOOK = "https://hybrid-ai-records.com/api/webhooks/music";

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
  const form = new FormData();
  if (bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    form.append("audio", new File([copy], filename, { type }));
  }
  form.append("userId", OTHER_USER);
  const headers = new Headers();
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vocals/upload", {
    method: "POST",
    headers,
    body: form,
  });
}

describe("POST /api/vocals/upload", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalVocalKey = process.env.AIMUSIC_API_KEY;
  const originalVocalAlias = process.env.AIMUSICAPI_KEY;
  const originalWebhookSecret = process.env.AIMUSICAPI_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.AIMUSIC_API_KEY = VOCAL_KEY;
    delete process.env.AIMUSICAPI_KEY;
    process.env.AIMUSICAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    getPublicUrlMock.mockReset();
    getPublicUrlMock.mockImplementation((path: string) => ({
      data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${path}` },
    }));
    fromMock.mockReset();
    fromMock.mockImplementation(() => ({ upload: uploadMock, getPublicUrl: getPublicUrlMock }));
    personaInsertMock.mockReset();
    personaInsertMock.mockResolvedValue({ error: null });
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => ({
      storage: { from: fromMock },
      from: (table: string) => {
        if (table !== "vocal_personas") throw new Error(`unexpected table ${table}`);
        return { insert: personaInsertMock };
      },
    }));
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ data: { path: "vocal-references/user/take.wav" }, error: null });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ data: { task_id: VOICE_TASK } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    resolveStudioSessionMock.mockReset();
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_021_000);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
    if (originalVocalKey === undefined) delete process.env.AIMUSIC_API_KEY;
    else process.env.AIMUSIC_API_KEY = originalVocalKey;
    if (originalVocalAlias === undefined) delete process.env.AIMUSICAPI_KEY;
    else process.env.AIMUSICAPI_KEY = originalVocalAlias;
    if (originalWebhookSecret === undefined) delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    else process.env.AIMUSICAPI_WEBHOOK_SECRET = originalWebhookSecret;
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
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();

    resolveStudioSessionMock.mockRejectedValue(
      Object.assign(new Error("Unauthorized session"), { name: "UnauthorizedSessionError", status: 401 }),
    );
    const rejected = await POST(uploadRequest(wavBytes()));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Invalid session" });
    expect(uploadMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("stores RIFF bytes as a wav buffer in audio-vault and returns the public url", async () => {
    const wav = wavBytes();
    const res = await POST(uploadRequest(wav, "Bearer a.b.c", "take.webm", "audio/webm"));
    expect(res.status).toBe(200);
    const fileName = "voice-take-1700000021000.wav";
    const objectPath = `vocal-references/${SESSION_USER}/${fileName}`;
    await expect(res.json()).resolves.toEqual({
      url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`,
      fileName,
      taskId: VOICE_TASK,
    });
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(fromMock).toHaveBeenCalledWith("audio-vault");
    expect(fromMock.mock.calls.every((call) => call[0] === "audio-vault")).toBe(true);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType?: string; upsert?: boolean },
    ];
    expect(path).toBe(objectPath);
    expect(path).not.toContain(OTHER_USER);
    expect(options).toMatchObject({ contentType: "audio/wav", upsert: true });
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body).not.toBeInstanceOf(Blob);
    expect(body).not.toBeInstanceOf(File);
    const bytes = body as Buffer;
    expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
    expect(bytes[0]).toBe(0x52);
    expect(bytes[8]).toBe(0x57);
    expect(getPublicUrlMock).toHaveBeenCalledWith(objectPath);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [voiceUrl, voiceInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(voiceUrl).toBe(CREATE_VOICE_URL);
    const voiceHeaders = voiceInit.headers as Record<string, string>;
    expect(voiceHeaders.Authorization).toBe(`Bearer ${VOCAL_KEY}`);
    const voiceBody = JSON.parse(String(voiceInit.body)) as {
      audio_url: string;
      webhook_url: string;
      webhook_secret: string;
    };
    expect(voiceBody).toEqual({
      audio_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`,
      webhook_url: MUSIC_WEBHOOK,
      webhook_secret: WEBHOOK_SECRET,
    });
    expect(personaInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task_id: VOICE_TASK,
        user_id: SESSION_USER,
        status: "processing",
        audio_url: voiceBody.audio_url,
      }),
    );
    const responseText = JSON.stringify({
      url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`,
      fileName,
      taskId: VOICE_TASK,
    });
    expect(responseText).not.toContain(WEBHOOK_SECRET);
    expect(responseText).not.toContain(VOCAL_KEY);
  });

  it("stores non-RIFF bytes as webm", async () => {
    const res = await POST(uploadRequest(webmBytes(), "Bearer a.b.c", "take.wav", "audio/wav"));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { url: string; fileName: string };
    expect(payload.fileName).toBe("voice-take-1700000021000.webm");
    expect(payload.url).toBe(
      `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/voice-take-1700000021000.webm`,
    );
    const [, body, options] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType?: string; upsert?: boolean },
    ];
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body).not.toBeInstanceOf(Blob);
    expect(options).toMatchObject({ contentType: "audio/webm", upsert: true });

    uploadMock.mockClear();
    const plain = await POST(uploadRequest(new Uint8Array([1, 2, 3, 4]), "Bearer a.b.c", "note.txt", "text/plain"));
    expect(plain.status).toBe(200);
    const plainBody = (await plain.json()) as { fileName: string };
    expect(plainBody.fileName).toBe("voice-take-1700000021000.webm");
    const [, plainBuffer, plainOptions] = uploadMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { contentType?: string },
    ];
    expect(Buffer.isBuffer(plainBuffer)).toBe(true);
    expect(plainOptions.contentType).toBe("audio/webm");
  });

  it("rejects a missing file, an empty file, and a file over 15 MB", async () => {
    const missing = await POST(uploadRequest(null));
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toEqual({ error: "No audio file provided" });

    const empty = await POST(uploadRequest(new Uint8Array(), "Bearer a.b.c", "empty.wav", "audio/wav"));
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ error: "File empty or exceeds 15MB limit" });

    const oversized = await POST(
      uploadRequest(new Uint8Array(15 * 1024 * 1024 + 1), "Bearer a.b.c", "big.wav", "audio/wav"),
    );
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ error: "File empty or exceeds 15MB limit" });
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("logs the stringified storage error when the reference upload fails", async () => {
    const uploadError = { message: "new row violates row-level security", statusCode: "403" };
    uploadMock.mockResolvedValue({ data: null, error: uploadError });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: uploadError.message });
    expect(errorSpy).toHaveBeenCalledWith(
      "[vocals] reference upload failed:",
      uploadError.message,
      expect.any(String),
    );
    const detail = errorSpy.mock.calls.find((call) => call[0] === "[vocals] reference upload failed:")?.[2];
    expect(typeof detail).toBe("string");
    expect(detail).toBe(JSON.stringify(uploadError, null, 2));
    expect(detail).not.toContain("service-role");
  });

  it("still returns 500 when the storage error cannot be stringified", async () => {
    const uploadError: { message: string; self?: unknown } = { message: "storage rejected" };
    uploadError.self = uploadError;
    uploadMock.mockResolvedValue({ data: null, error: uploadError });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "storage rejected" });
    expect(errorSpy).toHaveBeenCalledWith("[vocals] reference upload failed:", "storage rejected", uploadError);
  });

  it("returns a thrown error message from the route catch", async () => {
    const err = new Error("storage timed out");
    uploadMock.mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "storage timed out" });
    expect(body.error).not.toMatch(/\n/);
    expect(errorSpy).toHaveBeenCalledWith("[vocals] unexpected route exception:", err);
  });

  it("returns a short fallback when the route throws a non-error", async () => {
    uploadMock.mockRejectedValue("storage unavailable");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body).toEqual({ error: "Internal server error" });
    expect(errorSpy).toHaveBeenCalledWith("[vocals] unexpected route exception:", "storage unavailable");
  });

  it("strips a token query from the public object url before create-voice", async () => {
    const fileName = "voice-take-1700000021000.wav";
    const objectPath = `vocal-references/${SESSION_USER}/${fileName}`;
    getPublicUrlMock.mockImplementation((path: string) => ({
      data: { publicUrl: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/${path}?token=signed-token` },
    }));

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { url: string; taskId: string };
    expect(payload.url).toBe(`${SUPABASE_URL}/storage/v1/object/public/audio-vault/${objectPath}`);
    expect(payload.url).not.toContain("token=");
    const voiceBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      audio_url: string;
    };
    expect(voiceBody.audio_url).toBe(payload.url);
  });

  it("returns 502 when voice registration is not configured and keeps the stored object", async () => {
    delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { error: string; url?: string };
    expect(payload).toEqual({ error: "Could not register this vocal take." });
    expect(JSON.stringify(payload)).not.toContain(VOCAL_KEY);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(uploadMock.mock.calls[0]?.[1])).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(personaInsertMock).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((call) => String(call[0]).includes(WEBHOOK_SECRET))).toBe(false);
  });

  it("falls back to AIMUSICAPI_KEY and omits the webhook secret from the client JSON", async () => {
    delete process.env.AIMUSIC_API_KEY;
    process.env.AIMUSICAPI_KEY = "alias-vocal-key";

    const res = await POST(uploadRequest(wavBytes()));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload.taskId).toBe(VOICE_TASK);
    expect(JSON.stringify(payload)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(payload)).not.toContain("alias-vocal-key");
    expect(payload.webhook_secret).toBeUndefined();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer alias-vocal-key");
    expect(JSON.parse(String(init.body)).webhook_secret).toBe(WEBHOOK_SECRET);
    expect(JSON.parse(String(init.body)).webhook_url).toBe(MUSIC_WEBHOOK);
  });
});
