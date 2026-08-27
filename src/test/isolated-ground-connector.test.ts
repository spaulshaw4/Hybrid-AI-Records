import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import {
  IsolatedGroundConnector,
  executeWithGroundProtection,
} from "@/lib/IsolatedGroundConnector";
import { PipelineInformant } from "@/lib/PipelineInformant";

describe("IsolatedGroundConnector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies SECURITY HALT as QUARANTINE_NODE", () => {
    expect(
      IsolatedGroundConnector.classifyFaultSource(
        new Error("[SECURITY HALT] Payload quarantined"),
      ),
    ).toBe("QUARANTINE_NODE");
  });

  it("drains fault to ground and returns drain id", async () => {
    const spy = vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "core-execution-runner",
      { sessionNonce: "nonce_g1", requestId: "req_g1", jobId: "job_g1" },
    );

    const drainId = await IsolatedGroundConnector.drainFaultToGround(ctx, {
      errorCode: "CORE_EXECUTION_FAULT",
      faultSource: "UNKNOWN_SPIKE",
      rawContaminatedData: "stack trace here",
      drainNonce: "drain_nonce_g1",
    });

    expect(drainId).toMatch(/^ground_drain_nonce_g1_/);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ISOLATED_GROUND_DRAIN_TRIGGERED",
        jobId: "job_g1",
        metadata: expect.objectContaining({
          faultSource: "UNKNOWN_SPIKE",
          errorCode: "CORE_EXECUTION_FAULT",
          groundDrainId: drainId,
        }),
      }),
    );
  });

  it("executeWithGroundProtection returns GROUNDED_FAULT on throw", async () => {
    vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_prot" },
    );

    const result = await executeWithGroundProtection(ctx, async () => {
      throw new Error("[SECURITY HALT] Payload quarantined at node quarantine-isolation-node");
    });

    expect(result).toMatchObject({
      status: "GROUNDED_FAULT",
      errorHandled: true,
      faultSource: "QUARANTINE_NODE",
    });
    expect((result as { groundDrainReference: string }).groundDrainReference).toMatch(
      /^ground_drain_/,
    );
  });

  it("executeWithGroundProtection passes through success", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
    );
    const result = await executeWithGroundProtection(ctx, async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });

  it("is wired into worker failure path and sealed pipeline", () => {
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(worker).toContain("IsolatedGroundConnector.drainFaultToGround");
    expect(worker).toContain("groundDrainReference");

    const sealed = readFileSync(join(process.cwd(), "src/lib/WrappedCorePipeline.ts"), "utf8");
    expect(sealed).toContain("executeWithGroundProtection");
  });
});
