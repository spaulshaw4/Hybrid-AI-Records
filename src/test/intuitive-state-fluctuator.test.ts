import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { IntuitiveStateFluctuator } from "@/lib/IntuitiveStateFluctuator";
import { CtxFluctuatorEngine } from "@/lib/CtxFluctuatorEngine";

describe("IntuitiveStateFluctuator", () => {
  it("produces deterministic organic drift for the same CTX", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { requestId: "a1b2c3d4-e5f6-4789-8abc-def012345678", sessionNonce: "nonce_chaos_1" },
    );
    const a = IntuitiveStateFluctuator.computeIntuitiveDrift(ctx, 0.8);
    const b = IntuitiveStateFluctuator.computeIntuitiveDrift(ctx, 0.8);
    expect(a).toBe(b);
    expect(a).not.toBe(0.8);
    expect(Math.abs(a - 0.8)).toBeLessThanOrEqual(0.05 + 1e-6);
  });

  it("fluxCoatWithIntuition clamps temperature and stamps intuition flag", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { requestId: "ffffffff-0000-4000-8000-000000000001", sessionNonce: "n2" },
    );
    const coat = IntuitiveStateFluctuator.fluxCoatWithIntuition(ctx, "  ambient pulse  ", 0.72, 0.75);
    expect(coat.prompt).toBe("ambient pulse");
    expect(coat.intuitiveLogicApplied).toBe(true);
    expect(coat.resolvedTemperature).toBeGreaterThanOrEqual(0.1);
    expect(coat.resolvedTemperature).toBeLessThanOrEqual(1);
    expect(coat.stateNonce).toBe("n2");
  });

  it("different requestIds yield different drifts", () => {
    const base = {
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      tier: "pro" as const,
      sourceGate: "cortex-worker" as const,
      sessionNonce: "same_nonce",
    };
    const a = IntuitiveStateFluctuator.computeIntuitiveDrift(
      ContextFactory.create(base.userId, base.tier, base.sourceGate, {
        requestId: "11111111-1111-4111-8111-111111111112",
        sessionNonce: base.sessionNonce,
      }),
      0.8,
    );
    const b = IntuitiveStateFluctuator.computeIntuitiveDrift(
      ContextFactory.create(base.userId, base.tier, base.sourceGate, {
        requestId: "22222222-2222-4222-8222-222222222222",
        sessionNonce: base.sessionNonce,
      }),
      0.8,
    );
    expect(a).not.toBe(b);
  });
});

describe("CtxFluctuatorEngine + IntuitiveStateFluctuator", () => {
  it("applies logistic drift before returning coated envelope", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { requestId: "abcd1234-5678-4abc-8def-0123456789ab", sessionNonce: "locked_nonce" },
    );
    const out = CtxFluctuatorEngine.modulate(ctx, "aggressive cinematic pulse");
    expect(out.parameters.targetUserUuid).toBe(ctx.userId);
    expect(out.fluctuationNonce).toBe("locked_nonce");
    const prefs = out.envelope.profileSnapshot.preferences as {
      intuitiveStateFluctuator?: { applied?: boolean };
    };
    expect(prefs.intuitiveStateFluctuator?.applied).toBe(true);
  });

  it("is wired in CtxFluctuatorEngine source", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/CtxFluctuatorEngine.ts"), "utf8");
    expect(source).toContain("IntuitiveStateFluctuator.fluxCoatWithIntuition");
  });
});
