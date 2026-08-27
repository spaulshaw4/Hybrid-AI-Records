import { describe, expect, it, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FluctuatorEngine,
  FluctuatorRejectionError,
} from "@/lib/FluctuatorEngine";
import { ActuatorMonitor } from "@/lib/ActuatorMonitor";

describe("FluctuatorEngine (algorithmic)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing user, DEV UUID, and dev_test ids", () => {
    expect(() =>
      FluctuatorEngine.modulateGenerationParameters({
        userId: "",
        basePrompt: "test",
        sessionNonce: "n1",
      }),
    ).toThrow(FluctuatorRejectionError);

    expect(() =>
      FluctuatorEngine.modulateGenerationParameters({
        userId: "11111111-1111-4111-8111-111111111111",
        basePrompt: "test",
        sessionNonce: "n1",
      }),
    ).toThrow(FluctuatorRejectionError);

    expect(() =>
      FluctuatorEngine.modulateGenerationParameters({
        userId: "user_dev_test_01",
        basePrompt: "test",
        sessionNonce: "n1",
      }),
    ).toThrow(FluctuatorRejectionError);
  });

  it("scales pro vs free deterministically with zero I/O", () => {
    const userId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const pro = FluctuatorEngine.modulateGenerationParameters({
      userId,
      basePrompt: "noir synthwave",
      sessionNonce: "fluct_test_1",
      userTier: "pro",
    });
    const free = FluctuatorEngine.modulateGenerationParameters({
      userId,
      basePrompt: "noir synthwave",
      sessionNonce: "fluct_test_1",
      userTier: "free",
    });

    expect(pro.parameters.targetUserUuid).toBe(userId);
    expect(pro.parameters.isolatedEnvironment).toBe(true);
    expect(pro.parameters.executionEngine).toBe("algorithmic-deterministic");
    expect(pro.parameters.temperature).toBeGreaterThan(free.parameters.temperature);
    expect(pro.parameters.temperature).toBeGreaterThanOrEqual(0.75);
    expect(pro.parameters.steps).toBeGreaterThanOrEqual(150);
    expect(pro.parameters.styleWeight).toBeGreaterThanOrEqual(0.85);
    expect(pro.fluctuationNonce).toBe("fluct_test_1");

    expect(free.parameters.steps).toBeLessThanOrEqual(120);
    expect(free.parameters.styleWeight).toBeLessThanOrEqual(0.85);
  });

  it("is deterministic for identical inputs", () => {
    const input = {
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      basePrompt: "acid jazz",
      sessionNonce: "same_nonce",
      userTier: "enterprise" as const,
    };
    const a = FluctuatorEngine.modulateGenerationParameters(input);
    const b = FluctuatorEngine.modulateGenerationParameters(input);
    expect(a.parameters).toEqual(b.parameters);
    expect(a.prompt).toBe(b.prompt);
  });

  it("worker calls FluctuatorEngine before provider.generateTrack", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const fluctIdx = source.indexOf("CtxFluctuatorEngine.modulate");
    const genIdx = source.indexOf("provider.generateTrack");
    expect(fluctIdx).toBeGreaterThan(-1);
    expect(genIdx).toBeGreaterThan(fluctIdx);
    expect(source).toContain("ContextFactory.createFromQueueJob");
    expect(source).toContain("targetUserUuid");
    expect(source).toContain("EndGateDispatcher.deliverToUserVault");
  });

  it("does not call Supabase from FluctuatorEngine", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/FluctuatorEngine.ts"), "utf8");
    expect(source).not.toContain("tryGetSupabaseAdmin");
    expect(source).not.toContain('.from("profiles")');
    expect(source).toContain("algorithmic-deterministic");
    expect(source).toContain("algorithmicHash32");
  });
});

describe("ActuatorMonitor (algorithmic)", () => {
  it("returns OPTIMAL when queues are calm", () => {
    const result = ActuatorMonitor.evaluateHealth({
      pendingJobs: 2,
      processingJobs: 1,
      failedJobCount: 0,
    });
    expect(result.status).toBe("OPTIMAL");
    expect(result.recommendedAction).toBe("NONE");
  });

  it("flags CONGESTED on deep pending backlog", () => {
    const result = ActuatorMonitor.evaluateHealth({
      pendingJobs: 51,
      processingJobs: 3,
      failedJobCount: 2,
    });
    expect(result.status).toBe("CONGESTED");
    expect(result.recommendedAction).toBe("SCALE_THROTTLE_WINDOW");
  });

  it("flags CRITICAL when failures exceed threshold", () => {
    const result = ActuatorMonitor.evaluateHealth({
      pendingJobs: 1,
      processingJobs: 0,
      failedJobCount: 16,
    });
    expect(result.status).toBe("CRITICAL");
    expect(result.recommendedAction).toBe("TRIGGER_CIRCUIT_BREAKER_AND_ALERT");
  });

  it("is wired into pipeline actuator health readout", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/pipeline-actuator.server.ts"),
      "utf8",
    );
    expect(source).toContain("ActuatorMonitor.evaluateHealth");
  });
});
