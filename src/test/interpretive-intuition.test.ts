import { describe, expect, it, beforeEach } from "vitest";
import { InterpretiveLogic } from "@/lib/InterpretiveLogic";
import { FormulaBasedIntuition } from "@/lib/FormulaBasedIntuition";
import { FluctuatorEngine } from "@/lib/FluctuatorEngine";
import { DynamicLogicEngine } from "@/lib/DynamicLogicEngine";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("InterpretiveLogic", () => {
  it("scores aggressive / ambient descriptors", () => {
    const hot = InterpretiveLogic.interpretPrompt("aggressive heavy cinematic drop");
    const cool = InterpretiveLogic.interpretPrompt("ambient minimal chill soft");
    expect(hot.tempDelta).toBeGreaterThan(cool.tempDelta);
    expect(hot.stepsDelta).toBeGreaterThan(cool.stepsDelta);
    expect(hot.matchedTokens.length).toBeGreaterThan(0);
    expect(hot.complexityScore).toBeGreaterThanOrEqual(cool.complexityScore);
  });

  it("maps lo-fi and bass vectors", () => {
    const result = InterpretiveLogic.interpretPrompt("lo-fi heavy bass groove");
    expect(result.vectors.sampleRateScale).toBeLessThan(0);
    expect(result.vectors.lowEndEmphasis).toBeGreaterThan(0);
  });
});

describe("FormulaBasedIntuition", () => {
  beforeEach(() => {
    FormulaBasedIntuition.resetPidState();
  });

  it("sigmoid temperature rises with complexity", () => {
    const low = FormulaBasedIntuition.computeIntuitiveTemperature(10, 0.72);
    const high = FormulaBasedIntuition.computeIntuitiveTemperature(90, 0.72);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThanOrEqual(0.55);
    expect(high).toBeLessThanOrEqual(1.05);
  });

  it("log backoff grows smoothly with pending depth", () => {
    const calm = FormulaBasedIntuition.computeIntuitiveBackoff(2, 3000);
    const busy = FormulaBasedIntuition.computeIntuitiveBackoff(80, 3000);
    expect(busy).toBeGreaterThan(calm);
    expect(busy).toBeLessThanOrEqual(12000);
  });

  it("PID flags pre-trip on high failure counts", () => {
    const pressure = FormulaBasedIntuition.computeFailurePressure(16, 15);
    expect(pressure.shouldPreTrip).toBe(true);
    expect(pressure.pressure).toBeGreaterThan(0);
  });
});

describe("Fluctuator + DynamicLogic integration", () => {
  it("Fluctuator applies interpretive + intuition layers", () => {
    const out = FluctuatorEngine.modulateGenerationParameters({
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      basePrompt: "aggressive complex cinematic trance",
      sessionNonce: "nonce_int_1",
      userTier: "pro",
    });
    expect(out.parameters.executionEngine).toBe("algorithmic-deterministic");
    expect(out.profileSnapshot.preferences).toHaveProperty("interpretive");
    const interpretive = out.profileSnapshot.preferences.interpretive as {
      matchedTokens: string[];
    };
    expect(interpretive.matchedTokens.length).toBeGreaterThan(0);
  });

  it("DynamicLogicEngine throttle uses continuous backoff", () => {
    const a = DynamicLogicEngine.calculateAdaptiveThrottle(2, 3000);
    const b = DynamicLogicEngine.calculateAdaptiveThrottle(120, 3000);
    expect(b).toBeGreaterThan(a);
  });

  it("sources wire InterpretiveLogic and FormulaBasedIntuition", () => {
    const fluct = readFileSync(join(process.cwd(), "src/lib/FluctuatorEngine.ts"), "utf8");
    const dyn = readFileSync(join(process.cwd(), "src/lib/DynamicLogicEngine.ts"), "utf8");
    const act = readFileSync(join(process.cwd(), "src/lib/ActuatorMonitor.ts"), "utf8");
    expect(fluct).toContain("InterpretiveLogic.interpretPrompt");
    expect(fluct).toContain("FormulaBasedIntuition.computeIntuitiveTemperature");
    expect(dyn).toContain("FormulaBasedIntuition.computeIntuitiveBackoff");
    expect(act).toContain("computeFailurePressure");
  });
});
