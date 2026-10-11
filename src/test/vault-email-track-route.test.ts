import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createClientMock,
  fromMock,
  selectMock,
  eqMock,
  maybeSingleMock,
  storageFromMock,
  createSignedUrlMock,
  resolveStudioSessionMock,
  sendMock,
} = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  const eqMock = vi.fn();
  const selectMock = vi.fn();
  const fromMock = vi.fn();
  const createSignedUrlMock = vi.fn();
  const storageFromMock = vi.fn();
  const createClientMock = vi.fn();
  const resolveStudioSessionMock = vi.fn();
  const sendMock = vi.fn();
  return {
    createClientMock,
    fromMock,
    selectMock,
    eqMock,
    maybeSingleMock,
    storageFromMock,
    createSignedUrlMock,
    resolveStudioSessionMock,
    sendMock,
  };
});

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

vi.mock("resend", () => ({
  Resend: class Resend {
    emails = { send: (...args: unknown[]) => sendMock(...args) };
  },
}));

import { POST } from "@/app/api/vault/email-track/route";

const SUPABASE_URL = "https://example.supabase.co";
const SESSION_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_USER = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const TRACK_ID = "track-night-drive";
const PUBLIC_WAV = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/night.wav`;
const PUBLIC_MP3 = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/night.mp3`;
const SIGNED = `${SUPABASE_URL}/storage/v1/object/sign/audio-vault/masters/night.wav?token=test-signature`;

function restoreEnv(
  name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY" | "RESEND_API_KEY" | "RESEND_FROM" | "RESEND_TEST_MODE",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function post(body: unknown, authorization?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vault/email-track", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/vault/email-track", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalResend = process.env.RESEND_API_KEY;
  const originalFrom = process.env.RESEND_FROM;
  const originalTestMode = process.env.RESEND_TEST_MODE;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.RESEND_API_KEY = "re_test_vault_email";
    delete process.env.RESEND_FROM;
    delete process.env.RESEND_TEST_MODE;
    maybeSingleMock.mockReset();
    createSignedUrlMock.mockReset();
    sendMock.mockReset();
    resolveStudioSessionMock.mockReset();
    eqMock.mockReset();
    selectMock.mockReset();
    fromMock.mockReset();
    storageFromMock.mockReset();
    createClientMock.mockReset();
    eqMock.mockImplementation(() => ({ eq: eqMock, maybeSingle: maybeSingleMock }));
    selectMock.mockImplementation(() => ({ eq: eqMock }));
    fromMock.mockImplementation(() => ({ select: selectMock }));
    storageFromMock.mockImplementation(() => ({ createSignedUrl: createSignedUrlMock }));
    createClientMock.mockImplementation(() => ({
      from: fromMock,
      storage: { from: storageFromMock },
    }));
    sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  afterEach(() => {
    restoreEnv("NEXT_PUBLIC_SUPABASE_URL", originalUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalService);
    restoreEnv("RESEND_API_KEY", originalResend);
    restoreEnv("RESEND_FROM", originalFrom);
    restoreEnv("RESEND_TEST_MODE", originalTestMode);
  });

  it("returns 401 without a session and does not read the vault or email", async () => {
    const res = await POST(post({ trackId: TRACK_ID, userId: OTHER_USER }));

    expect(res.status).toBe(401);
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized session" });
  });

  it("returns 404 when the row is not owned and does not email", async () => {
    resolveStudioSessionMock.mockResolvedValue({
      userId: SESSION_USER,
      email: "artist@example.com",
    });
    maybeSingleMock.mockResolvedValue({ data: null, error: null });

    const res = await POST(post({ trackId: TRACK_ID, userId: OTHER_USER }, "Bearer a.b.c"));

    expect(res.status).toBe(404);
    expect(eqMock).toHaveBeenCalledWith("id", TRACK_ID);
    expect(eqMock).toHaveBeenCalledWith("user_id", SESSION_USER);
    expect(eqMock).not.toHaveBeenCalledWith("user_id", OTHER_USER);
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "That track is not in your vault." });
  });

  it("signs a 48 hour URL and does not return it", async () => {
    resolveStudioSessionMock.mockResolvedValue({
      userId: SESSION_USER,
      email: "artist@example.com",
    });
    maybeSingleMock.mockResolvedValue({
      data: {
        id: TRACK_ID,
        user_id: SESSION_USER,
        title: "Night Drive",
        wav_url: PUBLIC_WAV,
        mp3_url: PUBLIC_MP3,
      },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: SIGNED },
      error: null,
    });

    const res = await POST(post({ trackId: TRACK_ID, userId: OTHER_USER }, "Bearer a.b.c"));
    const raw = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(raw).not.toContain(SIGNED);
    expect(raw).not.toContain("token=");
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, expect.any(String), {
      auth: { persistSession: false },
    });
    expect(storageFromMock).toHaveBeenCalledWith("audio-vault");
    expect(createSignedUrlMock).toHaveBeenCalledWith("masters/night.wav", 172800);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const payload = sendMock.mock.calls[0][0] as {
      from: string;
      to: string;
      subject: string;
      html: string;
      attachments?: unknown;
      react?: unknown;
    };
    expect(payload.from).toBe("Hybrid AI Records <support@hybrid-ai-records.com>");
    expect(payload.to).toBe("artist@example.com");
    expect(payload.subject).toBe("Audio Master Download — Night Drive | Hybrid AI Records Vault");
    expect(payload.subject).toContain("Night Drive");
    expect(payload.html).toContain("Download Master Audio");
    expect(payload.html).toContain(SIGNED);
    expect(payload.html).toContain("48 hours");
    expect(payload.attachments).toBeUndefined();
    expect(payload.react).toBeUndefined();
  });

  it("returns 409 when the track has no master audio and does not email", async () => {
    resolveStudioSessionMock.mockResolvedValue({
      userId: SESSION_USER,
      email: "artist@example.com",
    });
    maybeSingleMock.mockResolvedValue({
      data: {
        id: TRACK_ID,
        user_id: SESSION_USER,
        title: "Night Drive",
        wav_url: null,
        mp3_url: "  ",
      },
      error: null,
    });

    const res = await POST(post({ trackId: TRACK_ID }, "Bearer a.b.c"));

    expect(res.status).toBe(409);
    expect(createSignedUrlMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "This track has no master audio yet." });
  });

  it("falls back to clearance@ when Resend rejects support@ and still hides the signed URL", async () => {
    resolveStudioSessionMock.mockResolvedValue({
      userId: SESSION_USER,
      email: "artist@example.com",
    });
    maybeSingleMock.mockResolvedValue({
      data: {
        id: TRACK_ID,
        user_id: SESSION_USER,
        title: "Night Drive",
        wav_url: PUBLIC_WAV,
        mp3_url: null,
      },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: SIGNED },
      error: null,
    });
    sendMock
      .mockResolvedValueOnce({
        data: null,
        error: { message: "Invalid from address. support@hybrid-ai-records.com is not verified." },
      })
      .mockResolvedValueOnce({ data: { id: "email_2" }, error: null });

    const res = await POST(post({ trackId: TRACK_ID }, "Bearer a.b.c"));
    const raw = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(raw)).toEqual({ ok: true });
    expect(raw).not.toContain(SIGNED);
    expect(raw).not.toContain("token=");
    expect(sendMock).toHaveBeenCalledTimes(2);
    expect((sendMock.mock.calls[0][0] as { from: string }).from).toBe(
      "Hybrid AI Records <support@hybrid-ai-records.com>",
    );
    expect((sendMock.mock.calls[1][0] as { from: string }).from).toBe(
      "Hybrid AI Records <clearance@hybrid-ai-records.com>",
    );
  });

  it("returns the Resend validation reason without a link or key", async () => {
    resolveStudioSessionMock.mockResolvedValue({
      userId: SESSION_USER,
      email: "artist@example.com",
    });
    maybeSingleMock.mockResolvedValue({
      data: {
        id: TRACK_ID,
        user_id: SESSION_USER,
        title: "Night Drive",
        wav_url: PUBLIC_WAV,
        mp3_url: PUBLIC_MP3,
      },
      error: null,
    });
    createSignedUrlMock.mockResolvedValue({
      data: { signedUrl: SIGNED },
      error: null,
    });
    sendMock.mockResolvedValue({
      data: null,
      error: { message: `Domain validation failed. See ${SIGNED}` },
    });

    const res = await POST(post({ trackId: TRACK_ID }, "Bearer a.b.c"));
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(502);
    expect(body.error).toBe("Email could not be sent. Domain validation failed.");
    expect(body.error).not.toContain(SIGNED);
    expect(body.error).not.toContain("token=");
    expect(body.error?.toLowerCase()).not.toContain("supabase");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
