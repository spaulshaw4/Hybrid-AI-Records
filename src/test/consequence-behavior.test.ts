import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConsequenceBehaviorEngine } from "@/lib/ConsequenceBehaviorEngine";
import { DynamicLogicEngine } from "@/lib/DynamicLogicEngine";

describe("ConsequenceBehaviorEngine", () => {
  beforeEach(() => {
    ConsequenceBehaviorEngine.resetForTests(1);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    ConsequenceBehaviorEngine.resetForTests(1);
  });

  it("tightens throttle on failure and eases on stable success", async () => {
    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const fail = await ConsequenceBehaviorEngine.adaptToConsequences({
      jobId: "22222222-2222-4222-8222-222222222222",
      success: false,
      executionDurationMs: 1200,
      errorMessage: "upstream timeout",
    });
    expect(fail.state).toBe("FAILURE_SPIKE");
    expect(fail.throttleMultiplier).toBeGreaterThan(1);

    ConsequenceBehaviorEngine.resetForTests(2.5);
    const ok = await ConsequenceBehaviorEngine.adaptToConsequences({
      jobId: "22222222-2222-4222-8222-222222222222",
      success: true,
      executionDurationMs: 4000,
    });
    expect(ok.state).toBe("STABLE_OPERATION");
    expect(ok.throttleMultiplier).toBeLessThan(2.5);
  });

  it("DynamicLogicEngine applies behavioral multiplier", () => {
    const base = DynamicLogicEngine.calculateAdaptiveThrottle(20, 3000, 1);
    const spiked = DynamicLogicEngine.calculateAdaptiveThrottle(20, 3000, 2.5);
    expect(spiked).toBeGreaterThan(base);
  });

  it("is wired into the generation worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("ConsequenceBehaviorEngine.adaptToConsequences");
    expect(source).toContain("refreshThrottleMultiplier");
  });
});
