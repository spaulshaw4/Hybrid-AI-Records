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
  uploadMock: vi.fn(async (..._args: unknown[]) => ({ data: { path: "vocals/task" }, error: null })),
  insertMock: vi.fn(async (..._args: unknown[]) => ({ error: null })),
  limitMock: vi.fn(async (..._args: unknown[]): Promise<{ data: Array<Record<string, unknown>>; error: null }> => ({
    data: [],
    error: null,
  })),
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
const WEBHOOK = "https://hybrid-ai-records.com/api/webhooks/music";
const WEBHOOK_SECRET = "vocal-song-webhook-secret";

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
  const originalAlias = process.env.AIMUSICAPI_KEY;
  const originalWebhookSecret = process.env.AIMUSICAPI_WEBHOOK_SECRET;
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.AIMUSIC_API_KEY = "test-key";
    delete process.env.AIMUSICAPI_KEY;
    process.env.AIMUSICAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
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
    if (originalAlias === undefined) delete process.env.AIMUSICAPI_KEY;
    else process.env.AIMUSICAPI_KEY = originalAlias;
    if (originalWebhookSecret === undefined) delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    else process.env.AIMUSICAPI_WEBHOOK_SECRET = originalWebhookSecret;
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

  it("forwards an audio-vault https vocalAudioUrl and does not fetch it", async () => {
    const reference = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/take.wav`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-vocal-ref" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({
        title: "Night Drive",
        lyrics: "[Chorus]\nwe go",
        vocalGender: "Female Vocal",
        styleTags: "close vocal, dry",
        vocalAudioUrl: reference,
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(CREATE_URL);
    expect(url).not.toBe(reference);
    expect(JSON.parse(String(init.body))).toEqual({
      custom_mode: true,
      mv: "sonic-v4-5",
      title: "Night Drive",
      tags: "Female Vocal, close vocal, dry",
      prompt: "[Chorus]\nwe go",
      webhook_url: WEBHOOK,
      webhook_secret: WEBHOOK_SECRET,
      reference_audio_url: reference,
    });
  });

  it("forwards reference_audio_url from the studio and ignores a body user id", async () => {
    const reference = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/voice-take-21.wav`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-vocal-ref-field" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({
        lyrics: "[Verse]\nline",
        userId: OTHER_USER,
        reference_audio_url: reference,
      }),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reference_audio_url).toBe(reference);
    expect(readVocalJob("task-vocal-ref-field")?.userId).toBe(SESSION_USER);
  });

  it("forwards referenceUrl when vocalAudioUrl is empty", async () => {
    const reference = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/take.mp3`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-vocal-alias" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({
        lyrics: "[Verse]\nline",
        vocalAudioUrl: "   ",
        referenceUrl: reference,
      }),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reference_audio_url).toBe(reference);
  });

  it("returns 400 for http and link-local references before debit and does not fetch them", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    for (const vocalAudioUrl of [
      "http://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/take.wav",
      "https://169.254.169.254/latest/meta-data",
      "https://169.254.1.1/latest",
      "http://127.0.0.1/vocal.wav",
    ]) {
      fetchMock.mockClear();
      spendRpcMock.mockClear();
      balanceMaybeSingleMock.mockClear();
      const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", vocalAudioUrl }));
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "Invalid vocal reference." });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spendRpcMock).not.toHaveBeenCalled();
      expect(balanceMaybeSingleMock).not.toHaveBeenCalled();
      expect(refundGenerationTokenMock).not.toHaveBeenCalled();
    }

    const httpReference = await generateVocals(
      vocalRequest({
        lyrics: "[Verse]\nline",
        reference_audio_url: "http://project.supabase.co/storage/v1/object/public/audio-vault/vocal-references/take.wav",
      }),
    );
    expect(httpReference.status).toBe(400);
    expect(spendRpcMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits a foreign https reference from the upstream body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-vocal-omit" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({
        lyrics: "[Verse]\nline",
        vocalAudioUrl: "https://cdn.example/vocal.wav",
      }),
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CREATE_URL);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reference_audio_url");
    expect(body.prompt).toBe("[Verse]\nline");
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
      webhook_secret: WEBHOOK_SECRET,
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

  it("forwards duration when it is an integer from 30 to 360 and omits it otherwise", async () => {
    let n = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== CREATE_URL) throw new Error("unexpected fetch");
      n += 1;
      return jsonResponse({ data: { task_id: `task-dur-${n}` } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const lockedFields = {
      custom_mode: true,
      mv: "sonic-v4-5",
      title: "Untitled Vocal",
      tags: "",
      prompt: "[Verse]\nline",
      webhook_url: WEBHOOK,
      webhook_secret: WEBHOOK_SECRET,
    };

    for (const duration of [30, 180, 360]) {
      fetchMock.mockClear();
      const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", duration }));
      expect(res.status).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ ...lockedFields, duration });
    }

    fetchMock.mockClear();
    const absent = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline" }));
    expect(absent.status).toBe(200);
    const [, absentInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(absentInit.body))).toEqual(lockedFields);
    expect(JSON.parse(String(absentInit.body))).not.toHaveProperty("duration");

    for (const duration of [29, 361, 180.5, "180", null]) {
      fetchMock.mockClear();
      const ignored = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", duration }));
      expect(ignored.status).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("duration");
      expect(body).toMatchObject(lockedFields);
    }
  });

  it("stores personaId on the job and leaves it off the upstream body", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-persona-1" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({ lyrics: "[Verse]\nline", personaId: "vocal_stephen_oct5_master" }),
    );

    expect(res.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("personaId");
    expect(body).not.toHaveProperty("vocalId");
    expect(body).not.toHaveProperty("duration");
    expect(readVocalJob("task-persona-1")).toEqual({
      taskId: "task-persona-1",
      userId: SESSION_USER,
      title: "Untitled Vocal",
      lyrics: "[Verse]\nline",
      tags: "",
      personaId: "vocal_stephen_oct5_master",
    });
  });

  it("accepts AIMUSICAPI_KEY when AIMUSIC_API_KEY is unset", async () => {
    delete process.env.AIMUSIC_API_KEY;
    process.env.AIMUSICAPI_KEY = "alias-vocal-key";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-alias-1" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(
      vocalRequest({ title: "Alias", lyrics: "[Verse]\nline", styleTags: "dry" }),
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ success: true, taskId: "task-alias-1" });
    expect(JSON.stringify(payload)).not.toContain("alias-vocal-key");
    expect(JSON.stringify(payload)).not.toContain(WEBHOOK_SECRET);
    expect(payload).not.toHaveProperty("webhook_secret");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer alias-vocal-key");
    expect(JSON.parse(String(init.body))).toEqual({
      custom_mode: true,
      mv: "sonic-v4-5",
      title: "Alias",
      tags: "dry",
      prompt: "[Verse]\nline",
      webhook_url: WEBHOOK,
      webhook_secret: WEBHOOK_SECRET,
    });
  });

  it("sends the music webhook callback and keeps the secret off the client JSON", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://studio.example.com";
    process.env.AIMUSICAPI_WEBHOOK_SECRET = WEBHOOK_SECRET;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: string) => {
      if (url === CREATE_URL) return jsonResponse({ data: { task_id: "task-webhook-1" } });
      throw new Error("unexpected fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline", title: "Callback" }));

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ success: true, taskId: "task-webhook-1" });
    expect(JSON.stringify(payload)).not.toContain(WEBHOOK_SECRET);
    expect(payload).not.toHaveProperty("webhook_secret");
    expect(payload).not.toHaveProperty("webhook_url");
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      webhook_url: "https://hybrid-ai-records.com/api/webhooks/music",
      webhook_secret: WEBHOOK_SECRET,
    });
    expect(JSON.stringify(logSpy.mock.calls)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(WEBHOOK_SECRET);
  });

  it("does not dispatch or reveal the secret when the webhook secret is unset", async () => {
    const sentinel = "must-not-leak";
    process.env.AIMUSICAPI_WEBHOOK_SECRET = sentinel;
    delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await generateVocals(vocalRequest({ lyrics: "[Verse]\nline" }));

    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload).toEqual({ error: "Failed to dispatch generation" });
    expect(JSON.stringify(payload)).not.toContain(sentinel);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
    expect(errorSpy).toHaveBeenCalledWith("[vocals] song callback is not configured");
    expect(refundGenerationTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: SESSION_USER, amount: 1 }),
    );
  });

  it("refunds the token when the API key is missing", async () => {
    delete process.env.AIMUSIC_API_KEY;
    delete process.env.AIMUSICAPI_KEY;
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
    insertMock.mockImplementation(async (row: unknown) => {
      stored.push(row as { task_id?: string });
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

  it("writes a remembered persona id into vocal_id_used", async () => {
    const taskId = "task-vocal-persona";
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.wav`;
    rememberVocalJob({
      taskId,
      userId: SESSION_USER,
      title: "Night Drive",
      lyrics: "[Verse]\nline",
      tags: "Male Vocal",
      personaId: "vocal_stephen_oct5_master",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("RIFFvocal"), { status: 200 })),
    );

    const res = await receiveVocalWebhook(
      webhookRequest({ task_id: taskId, data: { audio_url: AUDIO } }),
    );

    expect(res.status).toBe(200);
    expect(insertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: SESSION_USER,
        vocal_id_used: "vocal_stephen_oct5_master",
        wav_url: publicUrl,
        task_id: taskId,
      }),
    );
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
