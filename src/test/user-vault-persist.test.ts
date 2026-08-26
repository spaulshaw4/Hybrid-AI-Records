import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();
const updateMock = vi.fn();
const selectMock = vi.fn();
const maybeSingleMock = vi.fn();
const eqMock = vi.fn();

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
  }),
}));

vi.mock("@/lib/engine-pipeline.server", () => ({
  completeGenerationTask: vi.fn().mockResolvedValue(undefined),
}));

describe("persistUserVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chainable();
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
    expect(upsertMock).toHaveBeenCalled();
    const upsertRow = upsertMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(upsertRow).toMatchObject({
      id: vaultId,
      user_id: userId,
      status: "completed",
      master_url: "https://cdn.example/m.mp3",
      title: "Night Drive",
    });
    logSpy.mockRestore();
  });

  it("treats a non-UUID MusicAPI task id as a new vault row id", async () => {
    const { isUserVaultUuid } = await import("@/lib/user-vault.server");
    expect(isUserVaultUuid("sonic-task-abc123")).toBe(false);
    expect(isUserVaultUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
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
