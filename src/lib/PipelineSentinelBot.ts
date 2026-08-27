/**
 * Pipeline Sentinel Bot — autonomous self-healing & telemetry guardian.
 *
 * Runs outside the web request path. Periodically:
 *   1. Reads queue health (Actuator)
 *   2. Fires TriggerOrchestrator safeguards (CRITICAL → MAINTENANCE)
 *   3. Flushes stuck processing jobs
 *   4. Emits Informant heartbeats
 */

import {
  flushStuckGenerationJobs,
  readActuatorHealth,
} from "@/lib/pipeline-actuator.server";
import { PipelineInformant } from "@/lib/PipelineInformant";
import { PipelineActivatorSwitch } from "@/lib/PipelineActivatorSwitch";

const SENTINEL_INTERVAL_MS = Math.max(
  5_000,
  Number.parseInt(process.env.SENTINEL_INTERVAL_MS ?? "30000", 10) || 30_000,
);

let timer: ReturnType<typeof setInterval> | null = null;
let tickRunning = false;
let started = false;

export class PipelineSentinelBot {
  static isRunning(): boolean {
    return started;
  }

  /** Boot the sentinel daemon loop (idempotent). */
  static startSentinel(): void {
    if (started) {
      console.warn("[SENTINEL] Already running — ignoring duplicate start.");
      return;
    }
    started = true;
    console.info("[SENTINEL] Booted", { intervalMs: SENTINEL_INTERVAL_MS });

    // Immediate first pass, then cadence.
    void PipelineSentinelBot.tick().catch((err) => {
      console.error(
        "[SENTINEL] initial tick failed",
        err instanceof Error ? err.message : err,
      );
    });

    timer = setInterval(() => {
      void PipelineSentinelBot.tick().catch((err) => {
        console.error(
          "[SENTINEL] tick failed",
          err instanceof Error ? err.message : err,
        );
      });
    }, SENTINEL_INTERVAL_MS);

    // Don't keep the process alive solely via the timer reference semantics in some runners.
    if (typeof timer === "object" && timer && "unref" in timer === false) {
      /* node Timeout */
    }
  }

  /** Graceful stop — clears interval, no hanging timers. */
  static stopSentinel(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    started = false;
    tickRunning = false;
    console.info("[SENTINEL] Stopped cleanly.");
  }

  /** One guardian cycle. */
  static async tick(): Promise<void> {
    if (tickRunning) return;
    tickRunning = true;
    try {
      const armed = await PipelineActivatorSwitch.verifySystemArmed();

      // Concrete autonomous health & maintenance loop (DB metrics → thresholds → trip).
      const { PipelineAutomationEngine } = await import("@/lib/PipelineAutomationEngine");
      const automation = await PipelineAutomationEngine.evaluateAndEnforceSystemState();

      const pending = automation.pending;
      const processing = automation.processing;
      const failed = automation.failed;
      const evalStatus =
        automation.status === "TRIPPED"
          ? "CRITICAL"
          : automation.status === "HEALTHY"
            ? "OPTIMAL"
            : automation.status;

      let flushed = 0;
      if (
        evalStatus === "CONGESTED" ||
        evalStatus === "CRITICAL" ||
        automation.status === "TRIPPED" ||
        processing > 0
      ) {
        const flush = await flushStuckGenerationJobs();
        flushed = flush.stuckCount ?? 0;
      }

      // Keep Actuator health path warm for dashboards (also runs orchestrator safeguards).
      const health = await readActuatorHealth();

      PipelineInformant.emit({
        eventType: "ACTUATOR_HEALTH",
        metadata: {
          source: "pipeline-sentinel-bot",
          activatorState: armed.state,
          activatorArmed: armed.armed,
          evaluationStatus: evalStatus,
          automationStatus: automation.status,
          pending,
          processing,
          failed,
          safeguardTripped: automation.status === "TRIPPED",
          flushedStuck: flushed,
          actuatorStatus: health.status,
        },
      });

      console.info("[SENTINEL] heartbeat", {
        activator: armed.state,
        evaluation: evalStatus,
        automation: automation.status,
        pending,
        processing,
        failed,
        tripped: automation.status === "TRIPPED",
        flushed,
      });
    } finally {
      tickRunning = false;
    }
  }
}