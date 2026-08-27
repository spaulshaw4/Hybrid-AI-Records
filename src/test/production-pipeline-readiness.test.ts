import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

describe("production pipeline readiness", () => {
  it("ships .env.example with production lockdown keys", () => {
    const envExample = readFileSync(join(root, ".env.example"), "utf8");
    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "AIMUSICAPI_KEY",
      "SHARED_API_KEY",
      "ACTIVE_GENERATION_PROVIDER",
      "GENERATION_QUEUE_WORKER",
      "GENERATION_QUEUE_THROTTLE_MS",
      "ADMIN_ACTUATOR_SECRET",
      "ACTUATOR_FAILED_CRITICAL",
      "ACTUATOR_PENDING_CONGESTED",
      "ACTUATOR_PROCESSING_BACKLOG",
      "NEXT_PUBLIC_APP_URL",
      "PIPELINE_MASTER_STATE",
    ]) {
      expect(envExample).toContain(key);
    }
    expect(envExample).toMatch(/GENERATION_QUEUE_WORKER=external/);
    expect(envExample).not.toMatch(/service_role_eyJ/);
  });

  it("documents the production checklist", () => {
    expect(existsSync(join(root, "docs/PRODUCTION_PIPELINE.md"))).toBe(true);
    const doc = readFileSync(join(root, "docs/PRODUCTION_PIPELINE.md"), "utf8");
    expect(doc).toContain("npm run worker:generation-jobs");
    expect(doc).toContain("20260827140000_generation_queue.sql");
    expect(doc).toContain("20260827160000_system_config_activator.sql");
    expect(doc).toContain("Static Discharger");
  });

  it("keeps durable queue + claim + system_config migrations", () => {
    const queue = readFileSync(
      join(root, "supabase/migrations/20260827140000_generation_queue.sql"),
      "utf8",
    );
    expect(queue).toMatch(/CREATE TABLE IF NOT EXISTS public\.generation_queue/);
    expect(queue).toMatch(/claim_generation_queue_job/);
    expect(queue).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(queue).toMatch(/spend_idempotency_key/);
    expect(queue).toMatch(/prompt_payload jsonb/);

    const config = readFileSync(
      join(root, "supabase/migrations/20260827160000_system_config_activator.sql"),
      "utf8",
    );
    expect(config).toMatch(/CREATE TABLE IF NOT EXISTS public\.system_config/);
    expect(config).toMatch(/pipeline_master_state/);
    expect(config).toMatch(/'ARMED'/);

    const telemetry = readFileSync(
      join(root, "supabase/migrations/20260827150000_pipeline_telemetry_logs.sql"),
      "utf8",
    );
    expect(telemetry).toMatch(/pipeline_telemetry_logs/);
  });

  it("isolates workers on web via env and ships CLI worker script", () => {
    const worker = readFileSync(
      join(root, "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    expect(worker).toContain('v === "external"');
    expect(worker).toContain("PipelineActivatorSwitch.verifySystemArmed");
    expect(worker).toContain("DynamicLogicEngine.calculateAdaptiveThrottle");

    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["worker:generation-jobs"]).toContain("generation-jobs-worker");
    expect(existsSync(join(root, "scripts/generation-jobs-worker.ts"))).toBe(true);
  });

  it("keeps static discharger + activator + actuator wired", () => {
    const rootRoute = readFileSync(join(root, "src/routes/__root.tsx"), "utf8");
    expect(rootRoute).toContain("installStaticChargeMonitor");
    expect(rootRoute).toContain("AppErrorBoundary");

    const cortex = readFileSync(join(root, "src/lib/cortex-dispatcher.server.ts"), "utf8");
    expect(cortex).toContain("PipelineActivatorSwitch.verifySystemArmed");

    const logout = readFileSync(join(root, "src/components/LogoutButton.tsx"), "utf8");
    expect(logout).toContain("useStaticDischarger");
  });

  it("accepts SHARED_API_KEY as upstream alias", () => {
    const source = readFileSync(join(root, "src/lib/music-generation.ts"), "utf8");
    expect(source).toContain('trimProcessEnv("SHARED_API_KEY")');
  });
});
