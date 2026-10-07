import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  uploadMock,
  insertMock,
  limitMock,
  fromMock,
  resolveStudioSessionMock,
  balanceMaybeSingleMock,
  spendRpcMock,
  refundGenerationTokenMock,
} = vi.hoisted(() => ({
  uploadMock: vi.fn(async () => ({ data: { path: "vocals/task" }, error: null })),
  insertMock: vi.fn(async () => ({ error: null })),
  limitMock: vi.fn(async () => ({ data: [], error: null })),
  fromMock: vi.fn(),
  resolveStudioSessionMock: vi.fn(),
  balanceMaybeSingleMock: vi.fn(),
  spendRpcMock: vi.fn(),
  refundGenerationTokenMock: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    storage: { from: () => ({ upload: uploadMock }) },
    from: (table: string) => {
      fromMock(table);
      if (table === "token_balances") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => balanceMaybeSingleMock(),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => limitMock(),
            }),
          }),
        }),
        insert: (row: unknown) => insertMock(row),
      };
    },
    rpc: (fn: string, args: unknown) => spendRpcMock(fn, args),
  }),
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

vi.mock("@/lib/generation-tokens.server", () => ({
  refundGenerationToken: (...args: unknown[]) => refundGenerationTokenMock(...args),
}));

import { POST as generateVocals } from "@/app/api/vocals/generate/route";
import { POST as receiveVocalWebhook } from "@/app/api/webhooks/aimusic/route";
import { readVocalJob, rememberVocalJob, resetVocalJobs } from "@/lib/vocal-jobs.server";

const SESSION_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUPABASE_URL = "https://project.supabase.co";
const CREATE_URL = "https://api.aimusicapi.ai/api/v1/sonic/create";
const AUDIO = "https://cdn.example/vocal.wav";
const WEBHOOK = "https://hybrid-ai-records.com/api/webhooks/aimusic";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function vocalRequest(body: Record<string, unknown>, authorization = "Bearer a.b.c"): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return new Request("http://localhost/api/vocals/generate", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function webhookRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/webhooks/aimusic", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/vocals/generate", () => {
  const originalKey = process.env.AIMUSIC_API_KEY;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.AIMUSIC_API_KEY = "test-key";
    process.env.NEXT_PUBLIC_APP_URL = "http://127.0.0.1:8080";
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    balanceMaybeSingleMock.mockResolvedValue({ data: { balance: 4 }, error: null });
    spendRpcMock.mockResolvedValue({
      data: [{ ok: true, balance: 3, already_applied: false, reason: null }],
      error: null,
    });
    refundGenerationTokenMock.mockResolvedValue({ ok: true, balance: 4, alreadyApplied: false });
    resetVocalJobs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    uploadMock.mockClear();
    insertMock.mockReset();
    limitMock.mockReset();
    fromMock.mockReset();
    resolveStudioSessionMock.mockReset();
    balanceMaybeSingleMock.mockReset();
    spendRpcMock.mockReset();
    refundGenerationTokenMock.mockReset();
    resetVocalJobs();
    if (originalKey === undefined) delete process.env.AIMUSIC_API_KEY;
    else process.env.AIMUSIC_API_KEY = originalKey;
    if (originalAppUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  });

  it("returns 401 without a session and does not debit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const missing = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", userId: OTHER_USER }, ""));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: "Unauthorized session" });

    resolveStudioSessionMock.mockRejectedValue(
      Object.assign(new Error("Unauthorized session"), { name: "UnauthorizedSessionError", status: 401 }),
    );
    const rejected = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", userId: OTHER_USER }));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toEqual({ error: "Unauthorized session" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(balanceMaybeSingleMock).not.toHaveBeenCalled();
  });

  it("returns 400 for empty lyrics and does not debit", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const blank = await generateVocals(vocalRequest({ lyrics: "   ", title: "Night", userId: OTHER_USER }));
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({ error: "Lyrics are required." });

    const missing = await generateVocals(vocalRequest({ title: "Night", userId: OTHER_USER }));
    expect(missing.status).toBe(400);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(balanceMaybeSingleMock).not.toHaveBeenCalled();
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(refundGenerationTokenMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 402 when the conditional debit changes 0 rows and does not call upstream", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    spendRpcMock.mockResolvedValue({ data: [], error: null });

    const res = await generateVocals(
      vocalRequest({ lyrics: "[Verse]\nline", userId: OTHER_USER, vocalGender: "Male Vocal" }),
    );

    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toEqual({ error: "Insufficient hybrid tokens" });
    expect(JSON.stringify(body)).not.toMatch(/wavespeed|aimusic|sonic/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spendRpcMock).toHaveBeenCalledWith(
      "spend_hybrid_tokens",
      expect.objectContaining({ _user_id: SESSION_USER, _amount: 1 }),
    );
    expect(refundGenerationTokenMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the token deduction write fails and does not dispatch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    spendRpcMock.mockResolvedValue({ data: null, error: { message: "ledger write failed" } });

    const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Failed to process token deduction" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refundGenerationTokenMock).not.toHaveBeenCalled();
  });

  it("dispatches a vocal with the locked payload and does not insert a processing row", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-vocal-1" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({
        title: "  Night Drive  ",
        lyrics: "  [Chorus]\nwe go  ",
        vocalGender: "Female Vocal",
        styleTags: "soulful, dry",
        userId: OTHER_USER,
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ success: true, taskId: "task-vocal-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CREATE_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      custom_mode: true,
      mv: "sonic-v4-5",
      title: "Night Drive",
      tags: "Female Vocal, soulful, dry",
      prompt: "[Chorus]\nwe go",
      webhook_url: WEBHOOK,
    });
    expect(WEBHOOK).not.toMatch(/localhost|127\.0\.0\.1/i);
    expect(readVocalJob("task-vocal-1")).toEqual({
      taskId: "task-vocal-1",
      userId: SESSION_USER,
      title: "Night Drive",
      lyrics: "[Chorus]\nwe go",
      tags: "Female Vocal, soulful, dry",
    });
    expect(insertMock).not.toHaveBeenCalled();
    expect(fromMock.mock.calls.map((call) => call[0])).not.toContain("vaulted_tracks");
    expect(refundGenerationTokenMock).not.toHaveBeenCalled();
    expect(spendRpcMock).toHaveBeenCalledWith(
      "spend_hybrid_tokens",
      expect.objectContaining({ _user_id: SESSION_USER, _amount: 1 }),
    );
  });

  it("refunds the token when upstream dispatch fails and hides vendor text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "sonic upstream from aimusic exploded" }, 502)),
    );

    const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", title: "Night" }));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "Failed to dispatch generation" });
    expect(JSON.stringify(body)).not.toMatch(/wavespeed|aimusic|sonic/i);
    expect(refundGenerationTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: SESSION_USER,
        amount: 1,
        spendIdempotencyKey: expect.stringMatching(/^vocal:/),
      }),
    );
    expect(readVocalJob("task-vocal-1")).toBeUndefined();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("refunds the token when the API key is missing", async () => {
    delete process.env.AIMUSIC_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline" }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Missing API key" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spendRpcMock).toHaveBeenCalledTimes(1);
    expect(refundGenerationTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SESSION_USER, amount: 1 }),
    );
  });
});

describe("POST /api/webhooks/aimusic", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const stored: Array<{ task_id?: string }> = [];

  beforeEach(() => {
    stored.length = 0;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    limitMock.mockImplementation(async () => ({ data: stored.map((row) => ({ ...row })), error: null }));
    insertMock.mockImplementation(async (row: { task_id?: string }) => {
      stored.push(row);
      return { error: null };
    });
    uploadMock.mockResolvedValue({ data: { path: "vocals/task" }, error: null });
    resetVocalJobs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    uploadMock.mockClear();
    insertMock.mockReset();
    limitMock.mockReset();
    fromMock.mockReset();
    resetVocalJobs();
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
  });

  it("rejects http and link-local audio URLs without fetching", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const audio_url of [
      "http://cdn.example/a.wav",
      "https://169.254.169.254/latest/meta-data",
      "https://169.254.1.1/latest",
      "https://127.0.0.1/a.wav",
      "https://localhost/a.wav",
    ]) {
      fetchMock.mockClear();
      uploadMock.mockClear();
      const res = await receiveVocalWebhook(webhookRequest({ task_id: "task-bad", audio_url }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid webhook payload" });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(uploadMock).not.toHaveBeenCalled();
      expect(insertMock).not.toHaveBeenCalled();
    }
  });

  it("uploads vocals/${taskId}.wav and inserts one vaulted_tracks row for a remembered job", async () => {
    const taskId = "task-vocal-9";
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.wav`;
    rememberVocalJob({
      taskId,
      userId: SESSION_USER,
      title: "Night Drive",
      lyrics: "[Verse]\nline",
      tags: "Male Vocal, gritty",
    });
    const wav = Buffer.from("RIFFvocal");
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== AUDIO) throw new Error("unexpected fetch");
      return new Response(wav, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await receiveVocalWebhook(
      webhookRequest({
        task_id: taskId,
        userId: OTHER_USER,
        data: { audio_url: AUDIO },
      }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    expect(fetchMock).toHaveBeenCalledWith(AUDIO, expect.objectContaining({ redirect: "error" }));
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [string, Uint8Array, Record<string, unknown>];
    expect(path).toBe(`vocals/${taskId}.wav`);
    expect(body.byteLength).toBeGreaterThan(0);
    expect(options).toEqual({ contentType: "audio/wav", upsert: true });
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock).toHaveBeenCalledWith({
      user_id: SESSION_USER,
      title: "Night Drive",
      prompt: "Male Vocal, gritty",
      lyrics: "[Verse]\nline",
      vocal_id_used: null,
      wav_url: publicUrl,
      mp3_url: publicUrl,
      task_id: taskId,
    });
    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");

    const again = await receiveVocalWebhook(
      webhookRequest({ task_id: taskId, data: { audio_url: AUDIO } }),
    );
    expect(again.status).toBe(200);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it("stores the file and skips the insert when the pending job is gone", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("RIFFvocal"), { status: 200 })),
    );

    const res = await receiveVocalWebhook(
      webhookRequest({ data: { task_id: "task-orphan", audio_url: AUDIO } }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [string, Uint8Array, Record<string, unknown>];
    expect(path).toBe("vocals/task-orphan.wav");
    expect(body.byteLength).toBeGreaterThan(0);
    expect(options).toEqual({ contentType: "audio/wav", upsert: true });
    expect(insertMock).not.toHaveBeenCalled();
    expect(warn.mock.calls.some((call) => String(call[0]).includes("pending job was missing"))).toBe(true);
  });
});
