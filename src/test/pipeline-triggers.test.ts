import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pipeline DB triggers migration", () => {
  it("adds timestamp + queue audit triggers and QUEUE_* event types", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260827170000_pipeline_triggers.sql"),
      "utf8",
    );
    expect(sql).toMatch(/update_modified_column/);
    expect(sql).toMatch(/update_generation_queue_mod_time/);
    expect(sql).toMatch(/log_queue_state_change/);
    expect(sql).toMatch(/trg_queue_audit_trail/);
    expect(sql).toMatch(/QUEUE_PROCESSING/);
    expect(sql).toMatch(/QUEUE_FAILED/);
    expect(sql).toMatch(/CIRCUIT_BREAKER_TRIP/);
    expect(sql).toMatch(/pipeline_telemetry_logs/);
  });
});

describe("PipelineTriggerOrchestrator", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.ADMIN_ACTUATOR_SECRET = "test-secret";
    delete process.env.ACTUATOR_AUTO_TRIP;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ADMIN_ACTUATOR_SECRET;
    delete process.env.ACTUATOR_AUTO_TRIP;
  });

  it("does not trip on OPTIMAL load", async () => {
    const { PipelineTriggerOrchestrator } = await import(
      "@/lib/PipelineTriggerOrchestrator"
    );
    const result = await PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards({
      pendingJobs: 1,
      processingJobs: 0,
      failedJobCount: 0,
    });
    expect(result.tripped).toBe(false);
    if (!result.tripped) expect(result.status).toBe("OPTIMAL");
  });

  it("trips MAINTENANCE on CRITICAL failure count", async () => {
    const setState = vi.fn(async () => "MAINTENANCE");
    vi.doMock("@/lib/PipelineActivatorSwitch", () => ({
      PipelineActivatorSwitch: {
        setSystemState: setState,
        bustCache: vi.fn(),
      },
    }));
    vi.doMock("@/lib/PipelineInformant", () => ({
      PipelineInformant: {
        recordTelemetry: vi.fn(async () => undefined),
      },
    }));

    const { PipelineTriggerOrchestrator } = await import(
      "@/lib/PipelineTriggerOrchestrator"
    );
    const result = await PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards({
      pendingJobs: 0,
      processingJobs: 0,
      failedJobCount: 16,
    });

    expect(result.tripped).toBe(true);
    if (result.tripped) {
      expect(result.actionTaken).toBe("MAINTENANCE_ENGAGED");
    }
    expect(setState).toHaveBeenCalledWith("MAINTENANCE", "test-secret");
  });

  it("AutomationEngine evaluateAndEnforceSystemState is the concrete loop", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/PipelineAutomationEngine.ts"),
      "utf8",
    );
    expect(source).toContain("evaluateAndEnforceSystemState");
    expect(source).toContain("engageMaintenanceMode");
    expect(source).toContain("CIRCUIT_BREAKER_TRIP");
    expect(source).toContain("generation_queue");
  });

  it("is wired into actuator health + worker tick", () => {
    const actuator = readFileSync(
      join(process.cwd(), "src/lib/pipeline-actuator.server.ts"),
      "utf8",
    );
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(actuator).toContain("PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards");
    expect(worker).toContain("PipelineTriggerOrchestrator.evaluateAndTriggerSafeguards");
  });
});
