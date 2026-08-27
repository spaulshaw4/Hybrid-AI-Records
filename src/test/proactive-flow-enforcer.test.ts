import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";

describe("ProactiveFlowEnforcer", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.PIPELINE_MASTER_STATE;
    process.env.MAX_QUEUE_CAPACITY = "100";
    process.env.FREE_TIER_VELOCITY_LIMIT = "5";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIPELINE_MASTER_STATE;
  });

  it("rejects when Activator is in MAINTENANCE", async () => {
    process.env.PIPELINE_MASTER_STATE = "MAINTENANCE";
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    const { ProactiveFlowEnforcer } = await import("@/lib/ProactiveFlowEnforcer");
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "in-gate",
    );
    const result = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("SYSTEM_IN_MAINTENANCE");
    expect(result.httpStatus).toBe(503);
  });

  it("rejects on queue congestion backpressure", async () => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "2";
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    vi.doMock("@/integrations/supabase/client.server", () => ({
      tryGetSupabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              // pending count path (no gte)
              then: undefined,
              gte: undefined,
              count: 5,
              error: null,
            }),
          }),
        }),
      }),
    }));

    // Simpler mock: return pending 5 via chain that ends at eq for status pending
    vi.doMock("@/integrations/supabase/client.server", () => ({
      tryGetSupabaseAdmin: () => ({
        from: (table: string) => {
          if (table !== "generation_queue") throw new Error(table);
          return {
            select: () => ({
              eq: (_col: string, val: string) => {
                if (val === "pending") {
                  return Promise.resolve({ count: 5, error: null });
                }
                return {
                  gte: async () => ({ count: 0, error: null }),
                };
              },
            }),
          };
        },
      }),
    }));

    const { ProactiveFlowEnforcer } = await import("@/lib/ProactiveFlowEnforcer");
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "in-gate",
    );
    const result = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("QUEUE_CONGESTION_BACKPRESSURE");
    expect(result.httpStatus).toBe(429);
  });

  it("rejects free-tier velocity spikes", async () => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "100";
    process.env.FREE_TIER_VELOCITY_LIMIT = "5";
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();

    vi.doMock("@/integrations/supabase/client.server", () => ({
      tryGetSupabaseAdmin: () => ({
        from: () => ({
          select: () => ({
            eq: (_col: string, val: string) => {
              if (val === "pending") {
                return Promise.resolve({ count: 1, error: null });
              }
              // user_id filter → then gte(created_at)
              return {
                gte: async () => ({ count: 5, error: null }),
              };
            },
          }),
        }),
      }),
    }));

    const { ProactiveFlowEnforcer } = await import("@/lib/ProactiveFlowEnforcer");
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "in-gate",
    );
    const result = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("USER_VELOCITY_THROTTLE");
  });

  it("is wired in cortex before token burn", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/cortex-dispatcher.server.ts"),
      "utf8",
    );
    const preIdx = source.indexOf("handleIngatePreflight");
    const burnIdx = source.indexOf("authorizeAndSpendGenerationToken");
    expect(preIdx).toBeGreaterThan(-1);
    expect(burnIdx).toBeGreaterThan(preIdx);
  });
});
