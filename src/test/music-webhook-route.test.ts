// @vitest-environment node
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type DbCall = {
  table: string;
  op: string;
  payload?: unknown;
  filters?: Array<[string, unknown]>;
};

const { createClientMock, uploadMock, db } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  uploadMock: vi.fn(async () => ({ data: { path: "vocals/task.wav" }, error: null })),
  db: {
    calls: [] as DbCall[],
    vaultRows: [] as Array<Record<string, unknown>>,
    trackRows: [] as Array<Record<string, unknown>>,
    personaRows: [] as Array<Record<string, unknown>>,
    personaUpdateError: null as { message: string } | null,
    selectError: null as { message: string; code?: string } | null,
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

import { POST } from "@/app/api/webhooks/music/route";
import { rememberVocalJob, resetVocalJobs } from "@/lib/vocal-jobs.server";

const SECRET = "test-webhook-secret-fixed";
const SESSION_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUPABASE_URL = "https://project.supabase.co";
const AUDIO = "https://cdn.example/master.wav";

function rowsFor(table: string): Array<Record<string, unknown>> {
  if (table === "vaulted_tracks") return db.vaultRows.map((row) => ({ ...row }));
  if (table === "Track") return db.trackRows.map((row) => ({ ...row }));
  if (table === "vocal_personas") return db.personaRows.map((row) => ({ ...row }));
  return [];
}

function queryBuilder(table: string) {
  const query = {
    op: "",
    payload: undefined as unknown,
    filters: [] as Array<[string, unknown]>,
  };

  const execute = () => {
    if (query.op === "select") {
      db.calls.push({
        table,
        op: "select",
        filters: query.filters.map((pair) => [pair[0], pair[1]]),
      });
      if (db.selectError) return { data: null, error: db.selectError };
      return { data: rowsFor(table), error: null };
    }
    const op = query.op || "update";
    db.calls.push({
      table,
      op,
      payload: query.payload,
      filters: query.filters.map((pair) => [pair[0], pair[1]]),
    });
    if (table === "vocal_personas" && op === "update" && db.personaUpdateError) {
      return { data: null, error: db.personaUpdateError };
    }
    return { data: null, error: null };
  };

  const api = {
    update(payload: unknown) {
      query.op = "update";
      query.payload = payload;
      return api;
    },
    insert(payload: unknown) {
      db.calls.push({ table, op: "insert", payload });
      if (payload && typeof payload === "object") {
        const row = { ...(payload as Record<string, unknown>) };
        if (table === "vaulted_tracks") db.vaultRows.push(row);
        if (table === "tracks") db.trackRows.push(row);
      }
      return Promise.resolve({ data: null, error: null });
    },
    select() {
      query.op = "select";
      return api;
    },
    eq(column: string, value: unknown) {
      query.filters.push([column, value]);
      return api;
    },
    limit() {
      return Promise.resolve(execute());
    },
    then(
      onFulfilled: (value: { data: unknown; error: { message: string } | null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(execute()).then(onFulfilled, onRejected);
    },
  };
  return api;
}

function sign(rawBody: string, timestamp: string): string {
  return createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
}

function signedRequest(
  body: unknown,
  extra?: { timestamp?: string; signature?: string | null; omit?: Array<"timestamp" | "signature"> },
): Request {
  const rawBody = typeof body === "string" ? body : JSON.stringify(body);
  const timestamp = extra?.timestamp ?? String(Math.floor(Date.now() / 1000));
  const headers = new Headers({ "content-type": "application/json" });
  if (!extra?.omit?.includes("timestamp")) headers.set("x-webhook-timestamp", timestamp);
  if (!extra?.omit?.includes("signature")) {
    const signature = extra?.signature === undefined ? `sha256=${sign(rawBody, timestamp)}` : extra.signature;
    if (signature) headers.set("x-webhook-signature", signature);
  }
  return new Request("http://localhost/api/webhooks/music", {
    method: "POST",
    headers,
    body: rawBody,
  });
}

describe("POST /api/webhooks/music", () => {
  const originalSecret = process.env.AIMUSICAPI_WEBHOOK_SECRET;
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  beforeEach(() => {
    process.env.AIMUSICAPI_WEBHOOK_SECRET = SECRET;
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    db.calls.length = 0;
    db.vaultRows.length = 0;
    db.trackRows.length = 0;
    db.personaRows.length = 0;
    db.personaUpdateError = null;
    db.selectError = null;
    uploadMock.mockReset();
    uploadMock.mockResolvedValue({ data: { path: "vocals/task.wav" }, error: null });
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => ({
      from: (table: string) => queryBuilder(table),
      storage: {
        from: (bucket: string) => {
          db.calls.push({ table: bucket, op: "storage" });
          return { upload: uploadMock };
        },
      },
    }));
    resetVocalJobs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetVocalJobs();
    if (originalSecret === undefined) delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    else process.env.AIMUSICAPI_WEBHOOK_SECRET = originalSecret;
    if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = originalUrl;
    if (originalService === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalService;
    if (originalAnon === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = originalAnon;
  });

  it("returns 500 when the webhook secret is missing and does not log it", async () => {
    const sentinel = "super-secret-value";
    process.env.AIMUSICAPI_WEBHOOK_SECRET = sentinel;
    delete process.env.AIMUSICAPI_WEBHOOK_SECRET;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(signedRequest({ event: "song.failed", task_id: "task-1" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Server misconfigured" });
    expect(errorSpy).toHaveBeenCalledWith("[webhook] AIMUSICAPI_WEBHOOK_SECRET is not configured");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sentinel);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 400 when signature headers are missing", async () => {
    const res = await POST(signedRequest({ ok: true }, { omit: ["timestamp", "signature"] }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Missing signature headers" });

    const missingSignature = await POST(signedRequest({ ok: true }, { omit: ["signature"] }));
    expect(missingSignature.status).toBe(400);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a stale or non-numeric timestamp", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const stale = String(Math.floor(Date.now() / 1000) - 301);

    const expired = await POST(signedRequest({ event: "song.failed" }, { timestamp: stale }));
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual({ error: "Timestamp expired or invalid" });

    const invalid = await POST(signedRequest({ event: "song.failed" }, { timestamp: "nope" }));
    expect(invalid.status).toBe(401);
    await expect(invalid.json()).resolves.toEqual({ error: "Timestamp expired or invalid" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 401 for a bad signature and does not write or fetch audio", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const raw = JSON.stringify({
      event: "song.completed",
      code: 200,
      task_id: "task-song-ok",
      data: [{ state: "succeeded", audio_url: AUDIO }],
    });

    const res = await POST(signedRequest(raw, { signature: "00".repeat(32) }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Invalid signature" });
    expect(warnSpy).toHaveBeenCalledWith("[webhook] HMAC signature mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it("returns 401 for malformed signature hex", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const odd = await POST(signedRequest("{}", { signature: "abc" }));
    expect(odd.status).toBe(401);
    await expect(odd.json()).resolves.toEqual({ error: "Malformed signature hex" });

    const nonHex = await POST(signedRequest("{}", { signature: "zzzz" }));
    expect(nonHex.status).toBe(401);
    await expect(nonHex.json()).resolves.toEqual({ error: "Malformed signature hex" });

    const short = await POST(signedRequest("{}", { signature: "abcd" }));
    expect(short.status).toBe(401);
    await expect(short.json()).resolves.toEqual({ error: "Malformed signature hex" });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("updates vocal_personas to ready for a signed persona callback", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const named = await POST(
      signedRequest({
        task_id: "task-voice-1",
        data: { persona_id: "persona-abc", name: "Stephen Take" },
      }),
    );
    expect(named.status).toBe(200);
    await expect(named.json()).resolves.toEqual({ status: "ok", type: "persona_ready" });
    expect(logSpy).toHaveBeenCalledWith("[webhook:voice] Persona created: persona-abc (Stephen Take)");
    expect(db.calls).toContainEqual(
      expect.objectContaining({
        table: "vocal_personas",
        op: "update",
        payload: expect.objectContaining({
          persona_id: "persona-abc",
          persona_name: "Stephen Take",
          status: "ready",
        }),
        filters: [["task_id", "task-voice-1"]],
      }),
    );

    db.calls.length = 0;
    const unnamed = await POST(
      signedRequest({
        task_id: "task-voice-2",
        data: { persona_id: "persona-xyz" },
      }),
    );
    expect(unnamed.status).toBe(200);
    expect(logSpy).toHaveBeenCalledWith("[webhook:voice] Persona created: persona-xyz (Custom Take)");
    expect(db.calls).toContainEqual(
      expect.objectContaining({
        table: "vocal_personas",
        op: "update",
        payload: expect.objectContaining({
          persona_id: "persona-xyz",
          persona_name: "Custom Take",
          status: "ready",
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 500 when the persona update fails", async () => {
    db.personaUpdateError = { message: "relation vocal_personas does not exist" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      signedRequest({
        task_id: "task-voice-err",
        data: { persona_id: "persona-err", name: "Take" },
      }),
    );
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "DB write failed" });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
  });

  it("marks song.failed on vocal_personas without inserting a vault row", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      signedRequest({
        event: "song.failed",
        code: 200,
        task_id: "task-fail-1",
        message: "render failed",
        userId: OTHER_USER,
        data: [{ state: "succeeded", audio_url: AUDIO }],
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", received: "failed_logged" });
    expect(errorSpy).toHaveBeenCalledWith("[webhook] Task task-fail-1 failed:", "render failed");
    expect(db.calls).toContainEqual(
      expect.objectContaining({
        table: "vocal_personas",
        op: "update",
        payload: expect.objectContaining({ status: "failed", error_message: "render failed" }),
        filters: [["task_id", "task-fail-1"]],
      }),
    );
    expect(db.calls.some((call) => call.table === "tracks" || call.table === "Track")).toBe(false);
    expect(db.calls.some((call) => call.op === "insert")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("marks a non-200 code as failed and does not fetch audio", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await POST(
      signedRequest({
        event: "song.completed",
        code: 500,
        task_id: "task-code-fail",
        message: "upstream failed",
        data: [{ state: "succeeded", audio_url: AUDIO }],
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", received: "failed_logged" });
    expect(db.calls.some((call) => call.table === "tracks" || call.table === "Track")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch http or link-local audio on song.completed", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    rememberVocalJob({
      taskId: "task-song-bad",
      userId: SESSION_USER,
      title: "Night",
      lyrics: "line",
      tags: "grit",
      personaId: "persona-from-job",
    });

    const res = await POST(
      signedRequest({
        event: "song.completed",
        code: 200,
        task_id: "task-song-bad",
        userId: OTHER_USER,
        data: [
          { state: "succeeded", audio_url: "http://cdn.example/a.wav" },
          { state: "succeeded", audio_url: "https://169.254.169.254/latest/meta-data" },
          { state: "succeeded", audio_url: "https://169.254.1.1/latest" },
          { state: "running", audio_url: AUDIO },
        ],
      }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", type: "music_ready" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.op === "insert")).toBe(false);
  });

  it("rehosts a signed song.completed master into vaulted_tracks", async () => {
    const taskId = "task-song-ok";
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.wav`;
    rememberVocalJob({
      taskId,
      userId: SESSION_USER,
      title: "Job Title",
      lyrics: "job lyrics",
      tags: "job tags",
      personaId: "persona-from-job",
    });
    const fetchMock = vi.fn(async (url: string) => {
      if (url !== AUDIO) throw new Error(`unexpected fetch ${url}`);
      return new Response(Buffer.from("RIFFmaster"), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      event: "song.completed",
      code: 200,
      task_id: taskId,
      userId: OTHER_USER,
      data: [
        {
          state: "succeeded",
          title: "Night Drive",
          audio_url: AUDIO,
          lyric: "[Verse]\nline",
          prompt: "gritty",
        },
      ],
    };
    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", type: "music_ready" });
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test", {
      auth: { persistSession: false },
    });
    expect(createClientMock.mock.calls.every((call) => call[1] === "service-role-test")).toBe(true);
    expect(createClientMock.mock.calls.some((call) => call[1] === "anon-test")).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(AUDIO, expect.objectContaining({ redirect: "error" }));
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [path, body, options] = uploadMock.mock.calls[0] as unknown as [string, Buffer, { contentType?: string; upsert?: boolean }];
    expect(path).toBe(`vocals/${taskId}.wav`);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(options).toEqual({ contentType: "audio/wav", upsert: true });
    expect(db.calls).toContainEqual(expect.objectContaining({ table: "audio-vault", op: "storage" }));
    expect(db.calls).toContainEqual(
      expect.objectContaining({
        table: "vaulted_tracks",
        op: "insert",
        payload: {
          user_id: SESSION_USER,
          title: "Night Drive",
          prompt: "gritty",
          lyrics: "[Verse]\nline",
          vocal_id_used: "persona-from-job",
          wav_url: publicUrl,
          mp3_url: publicUrl,
          task_id: taskId,
        },
      }),
    );
    expect(db.calls.some((call) => call.table === "tracks" || call.table === "Track")).toBe(false);
    expect(publicUrl).not.toBe(AUDIO);
    expect(JSON.stringify(db.calls)).not.toContain(OTHER_USER);
    expect(db.calls.filter((call) => call.op === "select")).toEqual([
      expect.objectContaining({
        table: "vaulted_tracks",
        filters: [
          ["user_id", SESSION_USER],
          ["task_id", taskId],
        ],
      }),
    ]);

    const again = await POST(signedRequest(payload));
    expect(again.status).toBe(200);
    await expect(again.json()).resolves.toEqual({ status: "ok", type: "music_ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    expect(db.calls.filter((call) => call.op === "insert")).toHaveLength(1);
  });

  it("logs the vault lookup error from the service-role client", async () => {
    const taskId = "task-lookup-fail";
    const lookupError = { message: "permission denied for table vaulted_tracks", code: "42501" };
    db.selectError = lookupError;
    rememberVocalJob({
      taskId,
      userId: SESSION_USER,
      title: "Job Title",
      lyrics: "job lyrics",
      tags: "job tags",
      personaId: "persona-from-job",
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn(async () => {
      throw new Error("must not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const payload = {
      event: "song.completed",
      code: 200,
      task_id: taskId,
      userId: OTHER_USER,
      data: [{ state: "succeeded", title: "Night Drive", audio_url: AUDIO, lyric: "secret-lyric-body", prompt: "gritty" }],
    };
    const res = await POST(signedRequest(payload));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Internal error" });
    expect(errorSpy).toHaveBeenCalledWith("[webhook] vault lookup failed:", {
      table: "vaulted_tracks",
      userId: SESSION_USER,
      taskId,
      error: lookupError,
    });
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test", {
      auth: { persistSession: false },
    });
    expect(createClientMock.mock.calls.every((call) => call[1] === "service-role-test")).toBe(true);
    expect(createClientMock.mock.calls.some((call) => call[1] === "anon-test")).toBe(false);
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(AUDIO);
    expect(logged).not.toContain("secret-lyric-body");
    expect(logged).not.toContain("Authorization");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("uses the vocal_personas user id when the in-memory job is gone", async () => {
    db.personaRows.push({ user_id: SESSION_USER, persona_id: "persona-db" });
    const fetchMock = vi.fn(async () => new Response(Buffer.from("RIFFmaster"), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      signedRequest({
        event: "song.completed",
        code: 200,
        task_id: "task-from-persona",
        userId: OTHER_USER,
        data: [{ state: "succeeded", title: "From Persona", audio_url: AUDIO, lyric: "line", prompt: "dry" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(db.calls).toContainEqual(
      expect.objectContaining({
        table: "vaulted_tracks",
        op: "insert",
        payload: expect.objectContaining({
          user_id: SESSION_USER,
          vocal_id_used: "persona-db",
          title: "From Persona",
        }),
      }),
    );
    expect(JSON.stringify(db.calls.filter((call) => call.op === "insert"))).not.toContain(OTHER_USER);
  });

  it("acknowledges an unhandled verified payload", async () => {
    const res = await POST(signedRequest({ event: "ping", data: { ok: true } }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok", received: "unhandled_state" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON after a valid signature", async () => {
    const res = await POST(signedRequest("{"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid JSON" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("returns the error message without a stack when processing throws", async () => {
    const err = new Error("vault client exploded");
    createClientMock.mockImplementation(() => {
      throw err;
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = await POST(
      signedRequest({
        event: "song.completed",
        code: 200,
        task_id: "task-explode",
        data: [{ state: "succeeded", audio_url: AUDIO }],
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string; stack?: string };
    expect(body).toEqual({ error: "vault client exploded" });
    expect(body.stack).toBeUndefined();
    expect(body.error).not.toContain("\n");
    expect(errorSpy).toHaveBeenCalledWith("[webhook] Processing error:", err);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is mounted at /api/webhooks/music and compares the MAC with timingSafeEqual", () => {
    const server = readFileSync(join(process.cwd(), "src/server.ts"), "utf8");
    const route = readFileSync(join(process.cwd(), "src/app/api/webhooks/music/route.ts"), "utf8");
    const musicAt = server.indexOf('pathname === "/api/webhooks/music"');
    const genericAt = server.indexOf('startsWith("/api/webhooks")');
    expect(musicAt).toBeGreaterThan(-1);
    expect(server).toContain('import("./app/api/webhooks/music/route")');
    if (genericAt !== -1) expect(musicAt).toBeLessThan(genericAt);
    expect(route).toContain("timingSafeEqual");
    expect(route).not.toContain("next/server");
    expect(route).not.toContain("NextResponse");
    expect(route).not.toContain("providedMac ===");
    expect(route).not.toContain("expectedMac ===");
  });
});
