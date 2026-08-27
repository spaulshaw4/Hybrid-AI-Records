import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import { PipelineInformant } from "@/lib/PipelineInformant";
import { TelemetryAlignment, logReactorCheckpoint } from "@/lib/TelemetryAlignment";
import { DispatchAlignment, executeMusicGenerationDispatch } from "@/lib/DispatchAlignment";
import { SystemAlignmentRunner } from "@/lib/SystemAlignmentRunner";

describe("TelemetryAlignment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records uniform dialect via Informant", async () => {
    const spy = vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "aligned-runner",
      { requestId: "req_tel_1", sessionNonce: "nonce_tel_1" },
    );

    await TelemetryAlignment.recordEvent(ctx, {
      eventType: "DISPATCH_ALIGNED",
      status: "SUCCESS",
      details: { targetNode: "standard-worker-grid-pool" },
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "DISPATCH_ALIGNED",
        metadata: expect.objectContaining({
          requestId: "req_tel_1",
          sessionNonce: "nonce_tel_1",
          status: "SUCCESS",
          targetNode: "standard-worker-grid-pool",
        }),
      }),
    );
  });

  it("logReactorCheckpoint marks QUARANTINED when requested", async () => {
    const spy = vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
    );
    await logReactorCheckpoint(ctx, 0.09, true);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "DETANGLEMENT_REACTOR_CHECK",
        metadata: expect.objectContaining({
          status: "QUARANTINED",
          action: "STRIPPED_VECTORS",
        }),
      }),
    );
  });
});

describe("DispatchAlignment", () => {
  it("aligns sealed modulation into provider schema", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { requestId: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111", sessionNonce: "nonce_disp" },
    );
    const payload = DispatchAlignment.alignToProviderSchema(
      ctx,
      {
        title: "Neon Rain",
        genre: "synthwave",
        durationSeconds: 210,
        temperature: 0.8,
        styleWeight: 0.9,
        organicDrift: 0.03,
      },
      "enterprise-isolated-grid-01",
    );
    expect(payload.trackTitle).toBe("Neon Rain");
    expect(payload.genreVector).toBe("synthwave");
    expect(payload.durationSeconds).toBe(210);
    expect(payload.acousticParameters.chaosDrift).toBe(0.03);
    expect(payload.metadataStamps.targetNode).toBe("enterprise-isolated-grid-01");
    expect(payload.metadataStamps.sessionNonce).toBe("nonce_disp");
  });

  it("executeMusicGenerationDispatch returns mock asset URL", async () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_mock" },
    );
    const result = await executeMusicGenerationDispatch(ctx, { prompt: "ambient" }, "standard-worker-grid-pool");
    expect(result.status).toBe("DISPATCH_SUCCESS");
    expect(result.providerAssetUrl).toContain("nonce_mock");
  });
});

describe("SystemAlignmentRunner", () => {
  beforeEach(() => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "100";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.MAX_QUEUE_CAPACITY;
  });

  it("returns ALIGNED_EXECUTION_SUCCESS with settlement + provider payload", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();
    vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: (table: string) => {
        if (table === "generation_queue") {
          return {
            select: () => ({
              eq: (_c: string, val: string) => {
                if (val === "pending") return Promise.resolve({ count: 0, error: null });
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
      sanitizedPayload: {
        prompt: "aligned neon pulse",
        title: "Aligned",
        genre: "electronic",
        temperature: 0.7,
        durationSeconds: 200,
      },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_aligned",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const result = await SystemAlignmentRunner.runFullyAlignedPipeline(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "aligned neon pulse", title: "Aligned", genre: "electronic" },
    );

    expect(result.status).toBe("ALIGNED_EXECUTION_SUCCESS");
    if (result.status === "ALIGNED_EXECUTION_SUCCESS") {
      expect(result.settlement.settlementId).toMatch(/^settle_/);
      expect(result.providerPayload.trackTitle).toBeTruthy();
      expect(result.providerPayload.metadataStamps.targetNode).toBeTruthy();
      expect(result.rhythmBlueprint.accentPositions).toEqual([2, 4]);
      expect(result.theoryBlueprint.diatonicTriads).toHaveLength(7);
      expect(result.philosophyBlueprint.structuralCoherenceVerdict).toBe(
        "ONTOLOGICALLY_STABLE",
      );
      expect(result.vocalBalance.balanceBlueprintId).toMatch(/^vocal_balance_/);
      expect(result.vocalBalance.masterpieceCoherenceIndex).toBeGreaterThanOrEqual(0.965);
    }
  });

  it("grounds quarantine as ALIGNED_CIRCUIT_GROUNDED_FAULT", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();
    vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ count: 0, error: null }),
        }),
      }),
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

    const result = await SystemAlignmentRunner.runFullyAlignedPipeline(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "bad" },
    );

    expect(result.status).toBe("ALIGNED_CIRCUIT_GROUNDED_FAULT");
    if (result.status === "ALIGNED_CIRCUIT_GROUNDED_FAULT") {
      expect(result.groundReference).toMatch(/^ground_drain_/);
      expect(result.faultSource).toBe("QUARANTINE_NODE");
    }
  });

  it("is documented as the unified alignment composer", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/SystemAlignmentRunner.ts"),
      "utf8",
    );
    expect(source).toContain("ProactiveFlowEnforcer");
    expect(source).toContain("DispatchAlignment");
    expect(source).toContain("TelemetryAlignment");
    expect(source).toContain("LedgerSettlementGate");
    expect(source).toContain("IsolatedGroundConnector");

    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(worker).toContain("DispatchAlignment.alignToProviderSchema");
    expect(worker).toContain("DISPATCH_ALIGNED");
    expect(worker).toContain("BINARY_SUPPRESSION_APPLIED");
  });
});
