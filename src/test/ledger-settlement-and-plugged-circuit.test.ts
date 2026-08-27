import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { LedgerSettlementGate } from "@/lib/LedgerSettlementGate";
import { PipelineInformant } from "@/lib/PipelineInformant";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import { FullyPluggedCorePipeline } from "@/lib/FullyPluggedCorePipeline";

describe("LedgerSettlementGate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("commits settlement receipt with tier-based publisher routing", async () => {
    const spy = vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();
    const freeCtx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { sessionNonce: "nonce_settle_free", jobId: "job_settle_1" },
    );
    const free = await LedgerSettlementGate.settleAndClose(freeCtx, "vault_asset_1", 1);
    expect(free.publisherSyncStatus).toBe("VAULT_STORED_LOCAL");
    expect(free.settlementId).toMatch(/^settle_nonce_settle_free_/);
    expect(free.tokenCostDeducted).toBe(1);

    const entCtx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { sessionNonce: "nonce_settle_ent" },
    );
    const ent = await LedgerSettlementGate.settleAndClose(entCtx, "vault_asset_2", 2);
    expect(ent.publisherSyncStatus).toBe("QUEUED_FOR_DISTRIBUTION");
    expect(ent.tokenCostDeducted).toBe(2);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "LEDGER_SETTLEMENT_COMMITTED" }),
    );
  });

  it("is wired into End-Gate delivery and the worker success path", () => {
    const endGate = readFileSync(join(process.cwd(), "src/lib/EndGateDispatcher.ts"), "utf8");
    expect(endGate).toContain("LedgerSettlementGate.settleAndClose");
    expect(endGate).toContain("ledgerSettlement");

    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(worker).toContain("executionContext: ctx");
    expect(worker).toContain("settlement.settlementId");
    expect(worker).toContain("IsolatedGroundConnector.drainFaultToGround");
  });
});

describe("FullyPluggedCorePipeline", () => {
  beforeEach(() => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "100";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.MAX_QUEUE_CAPACITY;
  });

  it("returns a settlement receipt through the plugged circuit", async () => {
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
        prompt: "plugged circuit track",
        title: "Circuit",
        genre: "ambient",
        temperature: 0.7,
      },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_plugged",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const result = await FullyPluggedCorePipeline.executePluggedCircuit(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "plugged circuit track", title: "Circuit", genre: "ambient" },
    );

    expect("settlementId" in result).toBe(true);
    if ("settlementId" in result) {
      expect(result.vaultAssetId).toMatch(/^vault_asset_/);
      expect(result.publisherSyncStatus).toBe("VAULT_STORED_LOCAL");
      expect(result.tokenCostDeducted).toBe(1);
    }
  });

  it("grounds SECURITY HALT as CIRCUIT_GROUNDED_FAULT", async () => {
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

    const result = await FullyPluggedCorePipeline.executePluggedCircuit(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      { prompt: "bad" },
    );

    expect(result).toMatchObject({
      status: "CIRCUIT_GROUNDED_FAULT",
      faultSource: "QUARANTINE_NODE",
    });
    expect((result as { groundDrainReference: string }).groundDrainReference).toMatch(
      /^ground_drain_/,
    );
  });
});
