import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ContextFactory,
  ContextRejectionError,
} from "@/lib/ExecutionContext";
import { CtxFluctuatorEngine } from "@/lib/CtxFluctuatorEngine";

describe("ExecutionContext / ContextFactory", () => {
  it("seals an immutable CTX envelope", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { jobId: "22222222-2222-4222-8222-222222222222" },
    );
    expect(ctx.userId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(ctx.tier).toBe("pro");
    expect(ctx.sourceGate).toBe("cortex-worker");
    expect(ctx.jobId).toBe("22222222-2222-4222-8222-222222222222");
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(() => {
      (ctx as { tier: string }).tier = "free";
    }).toThrow();
  });

  it("rejects DEV / empty / dev_test identities", () => {
    expect(() => ContextFactory.create("")).toThrow(ContextRejectionError);
    expect(() =>
      ContextFactory.create("11111111-1111-4111-8111-111111111111"),
    ).toThrow(ContextRejectionError);
    expect(() => ContextFactory.create("user_dev_test_x")).toThrow(ContextRejectionError);
  });

  it("createFromQueueJob binds jobId and cortex-worker gate", () => {
    const ctx = ContextFactory.createFromQueueJob({
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      jobId: "22222222-2222-4222-8222-222222222222",
      correlationId: "cortex_abc",
      tier: "enterprise",
    });
    expect(ctx.sourceGate).toBe("cortex-worker");
    expect(ctx.requestId).toBe("cortex_abc");
    expect(ctx.tier).toBe("enterprise");
  });
});

describe("CtxFluctuatorEngine", () => {
  it("modulates strictly from CTX owner and tier", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_locked_1" },
    );
    const out = CtxFluctuatorEngine.modulate(ctx, "  neon rain  ");
    expect(out.modulatedPrompt).toBe("neon rain");
    expect(out.fluctuationNonce).toBe("nonce_locked_1");
    expect(out.parameters.targetUserUuid).toBe(ctx.userId);
    expect(out.parameters.isolatedEnvironment).toBe(true);
    expect(out.parameters.styleWeight).toBeGreaterThanOrEqual(0.85);
    expect(out.parameters.styleWeight).toBeLessThanOrEqual(0.95);
    expect(out.parameters.temperature).toBeGreaterThanOrEqual(0.7);
    expect(out.envelope.parameters.executionEngine).toBe("algorithmic-deterministic");
    expect(
      (out.envelope.profileSnapshot.preferences as { intuitiveStateFluctuator?: { applied?: boolean } })
        .intuitiveStateFluctuator?.applied,
    ).toBe(true);
  });

  it("free tier is cooler than pro for the same nonce family", () => {
    const free = CtxFluctuatorEngine.modulate(
      ContextFactory.create("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "free", "cortex-worker", {
        sessionNonce: "same",
      }),
      "pulse",
    );
    const pro = CtxFluctuatorEngine.modulate(
      ContextFactory.create("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "pro", "cortex-worker", {
        sessionNonce: "same",
      }),
      "pulse",
    );
    expect(free.parameters.temperature).toBeLessThan(pro.parameters.temperature);
    expect(free.parameters.steps).toBeLessThanOrEqual(pro.parameters.steps);
  });
});

describe("CTX worker wiring", () => {
  it("threads ContextFactory + CtxFluctuatorEngine through the worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(source).toContain("ContextFactory.createFromQueueJob");
    expect(source).toContain("CtxFluctuatorEngine.modulate");
    expect(source).toContain("userId: ctx.userId");
    expect(source).toContain("requestId: ctx.requestId");
    expect(source).toContain("ContextFactory.assertOwner");
  });
});
