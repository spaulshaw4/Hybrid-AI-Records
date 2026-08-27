import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("UserContextIngate", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves active user from request session without DEV override", async () => {
    const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    vi.doMock("@/lib/studio-request-auth.server", () => ({
      UnauthorizedSessionError: class UnauthorizedSessionError extends Error {
        status = 401;
        statusCode = 401;
      },
      resolveStudioSession: async () => ({
        userId,
        accessToken: "aaa.bbb.ccc",
        supabase: {},
      }),
    }));

    const { UserContextIngate } = await import("@/lib/UserContextIngate");
    const envelope = await UserContextIngate.resolveActiveUser(
      new Request("https://example.test/api/studio/generate-queue", {
        headers: { Authorization: "Bearer aaa.bbb.ccc" },
      }),
    );
    expect(envelope.userId).toBe(userId);
    expect(envelope.isDeveloperOverride).toBe(false);
    expect(envelope.tier).toBe("consumer");
  });

  it("rejects the well-known DEV UUID on fromVerifiedUserId", async () => {
    const { UserContextIngate, InGateRejectionError } = await import(
      "@/lib/UserContextIngate"
    );
    expect(() =>
      UserContextIngate.fromVerifiedUserId("11111111-1111-4111-8111-111111111111", {
        userId: "11111111-1111-4111-8111-111111111111",
        accessToken: "",
        supabase: {} as never,
      }),
    ).toThrow(InGateRejectionError);
  });
});

describe("EndGateDispatcher contracts", () => {
  it("rejects missing user binding and DEV UUID delivery targets", async () => {
    const { EndGateDispatcher, EndGateRejectionError } = await import(
      "@/lib/EndGateDispatcher"
    );
    await expect(
      EndGateDispatcher.deliverToUserVault({
        jobId: "22222222-2222-4222-8222-222222222222",
        userId: "",
        audioUrl: "https://cdn.example.com/a.mp3",
        prompt: "test",
        providerName: "hybrid-engine",
      }),
    ).rejects.toBeInstanceOf(EndGateRejectionError);

    await expect(
      EndGateDispatcher.deliverToUserVault({
        jobId: "22222222-2222-4222-8222-222222222222",
        userId: "11111111-1111-4111-8111-111111111111",
        audioUrl: "https://cdn.example.com/a.mp3",
        prompt: "test",
        providerName: "hybrid-engine",
      }),
    ).rejects.toBeInstanceOf(EndGateRejectionError);
  });

  it("worker routes delivery + failure through EndGateDispatcher", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("EndGateDispatcher.deliverToUserVault");
    expect(source).toContain("EndGateDispatcher.handleDeliveryFailure");
    expect(source).toContain("executionContext: ctx");
    expect(source).toContain("settlement.settlementId");
    expect(source).not.toContain("failJobWithRefund");
    expect(source).not.toContain("cortexGate3DeliverToVault");
  });

  it("cortex Gate 1 uses UserContextIngate", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/cortex-dispatcher.server.ts"),
      "utf8",
    );
    expect(source).toContain("UserContextIngate.resolveActiveUser");
    expect(source).toContain("fromVerifiedUserId");
    expect(source).toContain("isDeveloperOverride");
  });
});
