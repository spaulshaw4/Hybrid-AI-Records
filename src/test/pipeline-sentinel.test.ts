import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

describe("Pipeline Sentinel daemon", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const { PipelineSentinelBot } = await import("@/lib/PipelineSentinelBot");
      PipelineSentinelBot.stopSentinel();
    } catch {
      /* ignore */
    }
  });

  it("ships CLI entrypoint with graceful signal handlers", () => {
    const cli = readFileSync(join(process.cwd(), "scripts/run-sentinel.ts"), "utf8");
    expect(cli).toContain("PipelineSentinelBot");
    expect(cli).toContain("SIGINT");
    expect(cli).toContain("SIGTERM");
    expect(cli).toContain("stopSentinel");
  });

  it("exposes startSentinel / stopSentinel and runs health + safeguards", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/PipelineSentinelBot.ts"),
      "utf8",
    );
    expect(source).toContain("startSentinel");
    expect(source).toContain("stopSentinel");
    expect(source).toContain("PipelineAutomationEngine");
    expect(source).toContain("flushStuckGenerationJobs");
  });

  it("registers npm scripts and PM2 ecosystem", () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["worker:generation"]).toContain("generation-jobs-worker");
    expect(pkg.scripts["sentinel:daemon"]).toContain("run-sentinel");
    expect(pkg.scripts["production:cluster"]).toContain("concurrently");
    expect(existsSync(join(process.cwd(), "ecosystem.config.cjs"))).toBe(true);
    const eco = readFileSync(join(process.cwd(), "ecosystem.config.cjs"), "utf8");
    expect(eco).toContain("cortex-generation-worker");
    expect(eco).toContain("pipeline-sentinel-bot");
    expect(eco).toContain("GENERATION_QUEUE_WORKER");
  });

  it("start/stop is idempotent without throwing", async () => {
    vi.doMock("@/lib/pipeline-actuator.server", () => ({
      readActuatorHealth: async () => ({
        status: "HEALTHY",
        actuator: "ONLINE",
        evaluation: { status: "OPTIMAL", recommendedAction: "NONE" },
        metrics: { pendingJobs: 0, processingJobs: 0, failedRecent: 0 },
      }),
      flushStuckGenerationJobs: async () => ({ success: true, stuckCount: 0 }),
    }));
    vi.doMock("@/lib/PipelineAutomationEngine", () => ({
      PipelineAutomationEngine: {
        evaluateAndEnforceSystemState: async () => ({
          status: "HEALTHY",
          pending: 0,
          processing: 0,
          failed: 0,
          criticalThreshold: 15,
          tripped: false,
        }),
      },
    }));
    vi.doMock("@/lib/PipelineActivatorSwitch", () => ({
      PipelineActivatorSwitch: {
        verifySystemArmed: async () => ({
          armed: true,
          state: "ARMED",
          message: "ok",
        }),
      },
    }));
    vi.doMock("@/lib/PipelineInformant", () => ({
      PipelineInformant: { emit: vi.fn() },
    }));

    const { PipelineSentinelBot } = await import("@/lib/PipelineSentinelBot");
    PipelineSentinelBot.startSentinel();
    expect(PipelineSentinelBot.isRunning()).toBe(true);
    PipelineSentinelBot.startSentinel(); // duplicate
    PipelineSentinelBot.stopSentinel();
    expect(PipelineSentinelBot.isRunning()).toBe(false);
  });
});
