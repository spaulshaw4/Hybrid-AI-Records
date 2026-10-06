import { afterEach, describe, expect, it, vi } from "vitest";

const { createClientMock, fromMock, selectMock, orderMock, limitMock } = vi.hoisted(() => {
  const limitMock = vi.fn();
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  const selectMock = vi.fn(() => ({ order: orderMock }));
  const fromMock = vi.fn(() => ({ select: selectMock }));
  const createClientMock = vi.fn(() => ({ from: fromMock }));
  return { createClientMock, fromMock, selectMock, orderMock, limitMock };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

import { GET } from "@/app/api/vault/route";

const SUPABASE_URL = "https://example.supabase.co";

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
    selectMock.mockImplementation(() => ({ order: orderMock }));
    fromMock.mockImplementation(() => ({ select: selectMock }));
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

  it("prefers the service role key and maps vaulted_tracks rows", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
    limitMock.mockResolvedValue({
      data: [
        {
          id: "row-1",
          task_id: "task-1",
          title: "Night Drive",
          prompt: "Acoustic rock with a long tail",
          wav_url: "https://cdn.example/a.wav",
          mp3_url: "https://cdn.example/a.mp3",
        },
        {
          task_id: "task-2",
          title: "",
          prompt: "",
          wav_url: null,
          mp3_url: null,
        },
      ],
      error: null,
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "service-role-test");
    expect(fromMock).toHaveBeenCalledWith("vaulted_tracks");
    expect(selectMock).toHaveBeenCalledWith("*");
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
    limitMock.mockResolvedValue({ data: [], error: null });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(createClientMock).toHaveBeenCalledWith(SUPABASE_URL, "anon-test");
    await expect(res.json()).resolves.toEqual({ tracks: [] });
  });

  it("returns the query error message", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    limitMock.mockResolvedValue({ data: null, error: { message: "permission denied" } });

    const res = await GET();

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "permission denied" });
  });
});
