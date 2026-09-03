import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();
const updateMock = vi.fn();
const selectMock = vi.fn();
const maybeSingleMock = vi.fn();
const eqMock = vi.fn();
const getUserByIdMock = vi.fn();
const createUserMock = vi.fn();

function chainable(terminal: Record<string, unknown> = {}) {
  const api: Record<string, unknown> = {
    upsert: upsertMock,
    update: updateMock,
    insert: vi.fn(),
    select: selectMock,
    eq: eqMock,
    maybeSingle: maybeSingleMock,
    ...terminal,
  };
  upsertMock.mockReturnValue(api);
  updateMock.mockReturnValue(api);
  selectMock.mockReturnValue(api);
  eqMock.mockReturnValue(api);
  maybeSingleMock.mockResolvedValue({ data: null, error: null });
  return api;
}

vi.mock("@/integrations/supabase/client.server", () => ({
  tryGetSupabaseAdmin: () => ({
    from: () => chainable(),
    auth: {
      admin: {
        getUserById: getUserByIdMock,
        createUser: createUserMock,
      },
    },
  }),
}));

vi.mock("@/lib/engine-pipeline.server", () => ({
  completeGenerationTask: vi.fn().mockResolvedValue(undefined),
}));

describe("persistUserVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainable();
    getUserByIdMock.mockResolvedValue({
      data: { user: { id: "22222222-2222-4222-8222-222222222222" } },
      error: null,
    });
    createUserMock.mockResolvedValue({ data: { user: null }, error: null });
  });

  it("upserts a completed master with service-role client and logs the track id", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const vaultId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";

    // First update path: 0 rows → fall through to upsert
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null }) // update select
      .mockResolvedValueOnce({
        data: { id: vaultId, master_url: "https://cdn.example/m.mp3", status: "completed" },
        error: null,
      }); // upsert select

    const { persistUserVault } = await import("@/lib/user-vault.server");
    const id = await persistUserVault({} as never, userId, {
      id: vaultId,
      title: "Night Drive",
      style: "Synthwave",
      status: "completed",
      masterUrl: "https://cdn.example/m.mp3",
      instrumentalUrl: "https://cdn.example/i.mp3",
      vocalUrl: "https://cdn.example/v.mp3",
      tokensUsed: 1,
    });

    expect(id).toBe(vaultId);
    expect(logSpy).toHaveBeenCalledWith("Writing track to vault:", vaultId);
    expect(logSpy).toHaveBeenCalledWith(
      "[Vault Save Success]: Track ID saved ->",
      expect.objectContaining({ id: vaultId, status: "completed" }),
    );
    expect(upsertMock).toHaveBeenCalled();
    const upsertRow = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertRow).toMatchObject({
      id: vaultId,
      user_id: userId,
      status: "completed",
      master_url: "https://cdn.example/m.mp3",
      style: "Synthwave",
      title: "Night Drive",
    });
    logSpy.mockRestore();
  });

  it("treats a non-UUID MusicAPI task id as a new vault row id", async () => {
    const { isUserVaultUuid } = await import("@/lib/user-vault.server");
    expect(isUserVaultUuid("sonic-task-abc123")).toBe(false);
    expect(isUserVaultUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
  });

  it("writes provider_task_id on a pending processing row", async () => {
    const vaultId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";

    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: vaultId, master_url: null, status: "processing" },
        error: null,
      });

    const { persistUserVault } = await import("@/lib/user-vault.server");
    const id = await persistUserVault({} as never, userId, {
      id: vaultId,
      title: "Pending",
      style: "Pop",
      status: "processing",
      providerTaskId: "sonic-task-xyz",
    });

    expect(id).toBe(vaultId);
    expect(upsertMock).toHaveBeenCalled();
    const upsertRow = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertRow).toMatchObject({
      id: vaultId,
      status: "processing",
      style: "Pop",
      provider_task_id: "sonic-task-xyz",
    });
  });

  it("throws with [Vault Save Error] telemetry when upsert fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const vaultId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const dbError = {
      message: "insert or update on table \"user_vault\" violates foreign key constraint",
      code: "23503",
      details: "Key (user_id)=(22222222-2222-4222-8222-222222222222) is not present in table \"users\".",
    };

    getUserByIdMock.mockResolvedValue({ data: { user: null }, error: { message: "not found" } });
    maybeSingleMock
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: dbError })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: dbError });

    const { persistUserVault } = await import("@/lib/user-vault.server");
    await expect(
      persistUserVault({} as never, userId, {
        id: vaultId,
        title: "Broken",
        status: "completed",
        masterUrl: "https://cdn.example/m.mp3",
      }),
    ).rejects.toThrow(/Failed to save to user_vault/);

    expect(errorSpy).toHaveBeenCalledWith(
      "[Vault Save Error]:",
      expect.stringContaining("23503"),
    );
    errorSpy.mockRestore();
  });

  it("rejects non-uuid user ids before hitting the database", async () => {
    const { persistUserVault } = await import("@/lib/user-vault.server");
    await expect(
      persistUserVault({} as never, "GUEST/LOCAL", {
        title: "Nope",
        status: "processing",
      }),
    ).rejects.toThrow(/invalid user_id/);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("createGenerateSseResponse disconnect decoupling", () => {
  it("keeps the detached job running after stream cancel", async () => {
    const { createGenerateSseResponse } = await import("@/lib/studio-generate-stream.server");

    let resolveJob!: (value: { ok: true }) => void;
    const jobStarted = Promise.withResolvers<void>();
    const job = new Promise<{ ok: true }>((resolve) => {
      resolveJob = resolve;
    });

    const response = createGenerateSseResponse({
      run: async () => {
        jobStarted.resolve();
        return job;
      },
    });

    const reader = response.body!.getReader();
    await jobStarted.promise;

    // Simulate browser tab switch / fetch abort cancelling the SSE body.
    await reader.cancel();

    resolveJob({ ok: true });
    // If cancel aborted the job, this would hang or reject.
    await expect(job).resolves.toEqual({ ok: true });
  });
});
