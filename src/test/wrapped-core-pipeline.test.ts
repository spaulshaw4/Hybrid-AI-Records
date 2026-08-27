import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import { WrappedCorePipeline } from "@/lib/WrappedCorePipeline";

describe("WrappedCorePipeline", () => {
  beforeEach(() => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "100";
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.MAX_QUEUE_CAPACITY;
  });

  it("returns SEALED_AND_EXECUTING through the full wrapped path", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: (table: string) => {
        if (table === "generation_queue") {
          return {
            select: () => ({
              eq: (_c: string, val: string) => {
                if (val === "pending") {
                  return Promise.resolve({ count: 0, error: null });
                }
                return {
                  eq: async () => ({ count: 0, error: null }),
                  gte: async () => ({ count: 0, error: null }),
                };
              },
            }),
          };
        }
        return { insert: async () => ({ error: null }) };
      },
    } as never);

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: {
        prompt: "sealed neon rain",
        title: "Neon",
        genre: "synthwave",
        temperature: 0.7,
      },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_sealed_1",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const result = await WrappedCorePipeline.executeSealedPipeline(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "sealed neon rain", title: "Neon", genre: "synthwave" },
    );

    expect(result.status).toBe("SEALED_AND_EXECUTING");
    expect(result.assignedNode).toBe("standard-worker-grid-pool");
    expect(result.isolationNonce).toBe("reactor_sealed_1");
    expect(result.securityVerdict).toBe("PASSED_ISOLATION");
    expect(result.executionContext.sourceGate).toBe("core-execution-runner");
    expect(result.executionContext.userId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    expect(result.modulatedParameters.parameters.targetUserUuid).toBe(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(result.intuitiveCoat.intuitiveLogicApplied).toBe(true);
    expect(result.modulatedParameters.modulatedPrompt.length).toBeGreaterThan(0);
  });

  it("grounds quarantine verdict instead of crashing", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: (table: string) => {
        if (table === "generation_queue") {
          return {
            select: () => ({
              eq: (_c: string, val: string) => {
                if (val === "pending") {
                  return Promise.resolve({ count: 0, error: null });
                }
                // user velocity chain: .eq('user_id').gte(...)
                return {
                  gte: async () => ({ count: 0, error: null }),
                  eq: async () => ({ count: 0, error: null }),
                };
              },
            }),
          };
        }
        return { insert: async () => ({ error: null }) };
      },
    } as never);

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "bad" },
      reactorState: {
        entanglementLevel: 0.09,
        suppressionActive: true,
        reactorNonce: "reactor_q",
        entropyScore: 0.9,
        aggressiveDampening: true,
      },
    });

    const result = await WrappedCorePipeline.executeSealedPipeline(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "bad" },
    );

    expect(result.status).toBe("GROUNDED_FAULT");
    if (result.status === "GROUNDED_FAULT") {
      expect(result.errorHandled).toBe(true);
      expect(result.faultSource).toBe("QUARANTINE_NODE");
      expect(result.groundDrainReference).toMatch(/^ground_drain_/);
    }
  });

  it("grounds preflight rejection when Activator is in MAINTENANCE", async () => {
    process.env.PIPELINE_MASTER_STATE = "MAINTENANCE";
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    const result = await WrappedCorePipeline.executeSealedPipeline(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "x" },
    );

    expect(result.status).toBe("GROUNDED_FAULT");
    if (result.status === "GROUNDED_FAULT") {
      expect(result.errorHandled).toBe(true);
    }
  });

  it("ships as the sealed architecture composer module", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/WrappedCorePipeline.ts"),
      "utf8",
    );
    expect(source).toContain("ProactiveFlowEnforcer");
    expect(source).toContain("BinaryEntanglementSuppressor");
    expect(source).toContain("DeepIsolationPlacement");
    expect(source).toContain("IntuitiveStateFluctuator");
    expect(source).toContain("CtxFluctuatorEngine");
    expect(source).toContain("executeWithGroundProtection");
    expect(source).toContain("SEALED_AND_EXECUTING");
  });
});
