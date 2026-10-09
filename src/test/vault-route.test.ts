import { afterEach, describe, expect, it, vi } from "vitest";

const { createClientMock, fromMock, selectMock, orderMock, limitMock, eqMock, resolveStudioSessionMock } = vi.hoisted(() => {
  const limitMock = vi.fn();
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  const eqMock = vi.fn(() => ({ order: orderMock }));
  const selectMock = vi.fn(() => ({ order: orderMock, eq: eqMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  const createClientMock = vi.fn((..._args: unknown[]) => ({ from: fromMock }));
  const resolveStudioSessionMock = vi.fn();
  return { createClientMock, fromMock, selectMock, orderMock, limitMock, eqMock, resolveStudioSessionMock };
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

import { DELETE, GET } from "@/app/api/vault/route";

const SUPABASE_URL = "https://example.supabase.co";
const SESSION_USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VAULT_COLUMNS = "id, title, prompt, wav_url, mp3_url, created_at, user_id, task_id";

function bearerRequest() {
  return new Request("http://localhost/api/vault", {
    headers: { authorization: "Bearer a.b.c" },
  });
}

function restoreEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY" | "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("GET /api/vault", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  afterEach(() => {
    restoreEnv("NEXT_PUBLIC_SUPABASE_URL", originalUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalService);
    restoreEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", originalAnon);
    createClientMock.mockClear();
    fromMock.mockClear();
    selectMock.mockClear();
    orderMock.mockClear();
    limitMock.mockReset();
    orderMock.mockImplementation(() => ({ limit: limitMock }));
    eqMock.mockImplementation(() => ({ order: orderMock }));
    selectMock.mockImplementation(() => ({ order: orderMock, eq: eqMock }));
    fromMock.mockImplementation(() => ({ select: selectMock }));
    eqMock.mockClear();
    resolveStudioSessionMock.mockReset();
  });

  it("imports and returns 500 without calling Supabase when neither key is set", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    createClientMock.mockClear();

    const loaded = await import("@/app/api/vault/route");
    const res = await loaded.GET();

    expect(createClientMock).not.toHaveBeenCalled();
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "Supabase is not configured" });
  });

  it("returns 401 and does not read vaulted_tracks without a bearer session", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    limitMock.mockResolvedValue({
      data: [{ id: "row-1", user_id: SESSION_USER, title: "Feel It in the Rain" }],
      error: null,
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(fromMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
    expect(eqMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized session" });
  });

  it("prefers the service role key and maps only that user's vaulted_tracks rows", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    limitMock.mockResolvedValue({
      data: [
        {
          id: "row-1",
          task_id: "task-1",
          user_id: SESSION_USER,
          title: "Night Drive",
          prompt: "Acoustic rock with a long tail",
          wav_url: "https://cdn.example/a.wav",
          mp3_url: "https://cdn.example/a.mp3",
        },
        {
          task_id: "task-2",
          user_id: SESSION_USER,
          title: "",
          prompt: "",
          wav_url: null,
          mp3_url: null,
        },
        {
          id: "row-other",
          user_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
          title: "Feel It in the Rain",
          prompt: "not yours",
          wav_url: "https://cdn.example/leak.wav",
          mp3_url: "https://cdn.example/leak.mp3",
        },
      ],
      error: null,
    });

    const res = await GET(bearerRequest());

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");
    expect(selectMock).toHaveBeenCalledWith(VAULT_COLUMNS);
    expect(eqMock).toHaveBeenCalledWith("user_id", SESSION_USER);
    expect(orderMock).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(limitMock).toHaveBeenCalledWith(20);
    await expect(res.json()).resolves.toEqual({
      tracks: [
        {
          id: "row-1",
          title: "Night Drive",
          genre: "Acoustic rock with a lon",
          duration: "210s",
          status: "Ready",
          wav_url: "https://cdn.example/a.wav",
          mp3_url: "https://cdn.example/a.mp3",
        },
        {
          id: "task-2",
          title: "Untitled Master",
          genre: "",
          duration: "210s",
          status: "Ready",
          wav_url: null,
          mp3_url: null,
        },
      ],
    });
  });

  it("falls back to the anon key when the service role key is unset", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    limitMock.mockResolvedValue({ data: [], error: null });

    const res = await GET(bearerRequest());

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "anon-test");
    expect(eqMock).toHaveBeenCalledWith("user_id", SESSION_USER);
    await expect(res.json()).resolves.toEqual({ tracks: [] });
  });

  it("returns the query error message", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    limitMock.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const res = await GET(bearerRequest());

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "permission denied" });
  });

  it("scopes a bearer session to that user_id", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    limitMock.mockResolvedValue({
      data: [
        {
          id: "row-1",
          user_id: SESSION_USER,
          title: "Like the wind",
          prompt: "open air",
          wav_url: "https://cdn.example/a.wav",
          mp3_url: "https://cdn.example/a.mp3",
        },
      ],
      error: null,
    });

    const res = await GET(
      new Request("http://localhost/api/vault", {
        headers: { authorization: "Bearer a.b.c" },
      }),
    );

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(eqMock).toHaveBeenCalledWith("user_id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");
    await expect(res.json()).resolves.toMatchObject({
      tracks: [expect.objectContaining({ id: "row-1", title: "Like the wind" })],
    });
  });
});

describe("DELETE /api/vault/:id", () => {
  const originalUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const originalService = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const originalAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const taskId = "task-vocal-9";

  afterEach(() => {
    restoreEnv("NEXT_PUBLIC_SUPABASE_URL", originalUrl);
    restoreEnv("SUPABASE_SERVICE_ROLE_KEY", originalService);
    restoreEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", originalAnon);
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => ({ from: fromMock }));
    fromMock.mockReset();
    fromMock.mockImplementation(() => ({ select: selectMock }));
    resolveStudioSessionMock.mockReset();
  });

  function bearerDelete(body?: unknown) {
    return new Request(`http://localhost/api/vault/row-1`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer a.b.c",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  it("returns 401 and does not read vaulted_tracks without a session", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";

    const res = await DELETE(
      new Request("http://localhost/api/vault/row-1", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }),
      }),
    );

    expect(res.status).toBe(401);
    expect(createClientMock).not.toHaveBeenCalled();
    expect(fromMock).not.toHaveBeenCalled();
    expect(resolveStudioSessionMock).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized session" });
  });

  it("deletes only the matching user row and ignores a body userId", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    const removed: string[][] = [];
    const selectFilters: Array<[string, string]> = [];
    const deleteFilters: Array<[string, string]> = [];
    let deleted = false;
    const row = {
      id: "row-1",
      user_id: SESSION_USER,
      task_id: taskId,
      wav_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/shared.wav`,
      mp3_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.mp3`,
    };
    fromMock.mockImplementation((table: string) => {
      expect(table).toBe("vaulted_tracks");
      return {
        select: () => {
          const filters: Array<[string, string]> = [];
          const chain = {
            eq(column: string, value: string) {
              filters.push([column, value]);
              selectFilters.push([column, value]);
              return chain;
            },
            maybeSingle: async () => {
              const matches =
                filters.some(([column, value]) => column === "id" && value === row.id) &&
                filters.some(([column, value]) => column === "user_id" && value === row.user_id);
              return { data: matches ? row : null, error: null };
            },
          };
          return chain;
        },
        delete: () => {
          deleted = true;
          const filters: Array<[string, string]> = [];
          const chain = {
            eq(column: string, value: string) {
              filters.push([column, value]);
              deleteFilters.push([column, value]);
              return chain;
            },
            then(
              onFulfilled: (value: { error: null }) => unknown,
              onRejected?: (reason: unknown) => unknown,
            ) {
              return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
            },
          };
          return chain;
        },
      };
    });
    createClientMock.mockImplementation(() => ({
      from: fromMock,
      storage: {
        from: (bucket: string) => ({
          remove: async (paths: string[]) => {
            expect(bucket).toBe("audio-vault");
            removed.push(paths);
            return { error: null };
          },
        }),
      },
    }));

    const res = await DELETE(bearerDelete({ userId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" }));

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(selectFilters).toEqual([
      ["id", "row-1"],
      ["user_id", SESSION_USER],
    ]);
    expect(deleteFilters).toEqual([
      ["id", "row-1"],
      ["user_id", SESSION_USER],
    ]);
    expect(selectFilters.some(([, value]) => value === "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")).toBe(false);
    expect(deleteFilters.some(([, value]) => value === "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff")).toBe(false);
    expect(removed).toEqual([[`vocals/${taskId}.mp3`]]);
    expect(deleted).toBe(true);
    await expect(res.json()).resolves.toEqual({ success: true });
  });

  it("does not delete a row owned by someone else", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    let deleted = false;
    fromMock.mockImplementation(() => ({
      select: () => {
        const chain = {
          eq() {
            return chain;
          },
          maybeSingle: async () => ({
            data: {
              id: "row-1",
              user_id: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
              task_id: taskId,
              wav_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.mp3`,
              mp3_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocals/${taskId}.mp3`,
            },
            error: null,
          }),
        };
        return chain;
      },
      delete: () => {
        deleted = true;
        return { eq: () => ({ eq: async () => ({ error: null }) }) };
      },
    }));
    createClientMock.mockImplementation(() => ({
      from: fromMock,
      storage: { from: () => ({ remove: async () => ({ error: null }) }) },
    }));

    const res = await DELETE(bearerDelete());

    expect(res.status).toBe(404);
    expect(deleted).toBe(false);
    await expect(res.json()).resolves.toEqual({ error: "Vault track not found." });
  });

  it("removes a storage object under the session user's prefix", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    resolveStudioSessionMock.mockResolvedValue({ userId: SESSION_USER });
    const removed: string[][] = [];
    const ownedWav = `${SUPABASE_URL}/storage/v1/object/public/audio-vault/vocal-references/${SESSION_USER}/take.wav`;
    fromMock.mockImplementation(() => ({
      select: () => {
        const chain = {
          eq() {
            return chain;
          },
          maybeSingle: async () => ({
            data: {
              id: "row-1",
              user_id: SESSION_USER,
              task_id: taskId,
              wav_url: ownedWav,
              mp3_url: `${SUPABASE_URL}/storage/v1/object/public/audio-vault/masters/shared.mp3`,
            },
            error: null,
          }),
        };
        return chain;
      },
      delete: () => {
        const chain = {
          eq() {
            return chain;
          },
          then(onFulfilled: (value: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(onFulfilled);
          },
        };
        return chain;
      },
    }));
    createClientMock.mockImplementation(() => ({
      from: fromMock,
      storage: {
        from: () => ({
          remove: async (paths: string[]) => {
            removed.push(paths);
            return { error: null };
          },
        }),
      },
    }));

    const res = await DELETE(bearerDelete());

    expect(res.status).toBe(200);
    expect(removed).toEqual([[`vocal-references/${SESSION_USER}/take.wav`]]);
  });
});
