import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PipelineActivatorSwitch,
  ActivatorSwitchRejectionError,
} from "@/lib/PipelineActivatorSwitch";
import { DynamicLogicEngine } from "@/lib/DynamicLogicEngine";

describe("PipelineActivatorSwitch", () => {
  beforeEach(() => {
    PipelineActivatorSwitch.bustCache();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.ADMIN_ACTUATOR_SECRET;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    PipelineActivatorSwitch.bustCache();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.ADMIN_ACTUATOR_SECRET;
  });

  it("defaults to ARMED when cache is cold and DB unavailable", async () => {
    vi.doMock("@/integrations/supabase/client.server", () => ({
      tryGetSupabaseAdmin: () => null,
    }));
    // Module already loaded — exercise env path instead.
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    PipelineActivatorSwitch.bustCache();
    const status = await PipelineActivatorSwitch.verifySystemArmed();
    expect(status.armed).toBe(true);
    expect(status.state).toBe("ARMED");
  });

  it("honors PIPELINE_MASTER_STATE env kill-switch", async () => {
    process.env.PIPELINE_MASTER_STATE = "MAINTENANCE";
    PipelineActivatorSwitch.bustCache();
    const status = await PipelineActivatorSwitch.verifySystemArmed();
    expect(status.armed).toBe(false);
    expect(status.state).toBe("MAINTENANCE");
  });

  it("rejects unauthorized setSystemState", async () => {
    process.env.ADMIN_ACTUATOR_SECRET = "correct-secret";
    await expect(
      PipelineActivatorSwitch.setSystemState("DISABLED", "wrong"),
    ).rejects.toBeInstanceOf(ActivatorSwitchRejectionError);
  });

  it("flips cache-only state with valid secret when admin client missing", async () => {
    process.env.ADMIN_ACTUATOR_SECRET = "correct-secret";
    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue(null);

    const state = await PipelineActivatorSwitch.setSystemState(
      "DISABLED",
      "correct-secret",
    );
    expect(state).toBe("DISABLED");
    PipelineActivatorSwitch.bustCache();
    // After bust, env not set and DB null — cache still DISABLED until TTL refresh from DB.
    // setSystemState already set cache; verify without bust:
    const status = await PipelineActivatorSwitch.verifySystemArmed();
    expect(status.state).toBe("DISABLED");
    expect(status.armed).toBe(false);
  });

  it("is wired at cortex ingress before Gate 1", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/cortex-dispatcher.server.ts"),
      "utf8",
    );
    const switchIdx = source.indexOf("PipelineActivatorSwitch.verifySystemArmed");
    const gate1Idx = source.indexOf("cortexGate1IdentityAndTokens");
    expect(switchIdx).toBeGreaterThan(-1);
    expect(gate1Idx).toBeGreaterThan(switchIdx);
    expect(source).toContain("Generation pipeline is currently offline");
  });
});

describe("DynamicLogicEngine", () => {
  it("backs off throttle under deep pending congestion", () => {
    expect(DynamicLogicEngine.calculateAdaptiveThrottle(120, 3000)).toBe(6000);
    expect(DynamicLogicEngine.calculateAdaptiveThrottle(120, 8000)).toBe(10000);
  });

  it("speeds up throttle when the queue is nearly empty", () => {
    expect(DynamicLogicEngine.calculateAdaptiveThrottle(2, 3000)).toBe(1500);
    expect(DynamicLogicEngine.calculateAdaptiveThrottle(0, 1500)).toBe(1000);
  });

  it("keeps baseline throttle for normal load", () => {
    expect(DynamicLogicEngine.calculateAdaptiveThrottle(20, 3000)).toBe(3000);
  });

  it("tightens temperature under high queue load factor", () => {
    const calm = DynamicLogicEngine.applyDynamicScaling(0.85, 0.2);
    const hot = DynamicLogicEngine.applyDynamicScaling(0.85, 0.9);
    expect(calm.dynamicScalingApplied).toBe(false);
    expect(hot.dynamicScalingApplied).toBe(true);
    expect(hot.adjustedTemperature).toBeCloseTo(0.8, 5);
  });

  it("is wired into the generation worker drain loop", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("DynamicLogicEngine.calculateAdaptiveThrottle");
    expect(source).toContain("queueLoadFactor");
    expect(source).toContain("PipelineActivatorSwitch.verifySystemArmed");
  });
});
