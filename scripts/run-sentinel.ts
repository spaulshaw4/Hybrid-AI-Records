#!/usr/bin/env node
/**
 * Sentinel CLI entrypoint — boots the autonomous Pipeline Sentinel daemon.
 *
 * Usage:
 *   npm run sentinel:daemon
 *   npx tsx scripts/run-sentinel.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.production" });
dotenv.config({ path: ".env" });

console.log("==================================================");
console.log("  HYBRID AI RECORDS: PIPELINE SENTINEL DAEMON");
console.log("  Autonomous Self-Healing & Telemetry Guardian");
console.log("==================================================");

let stopping = false;

async function main() {
  const { PipelineSentinelBot } = await import("../src/lib/PipelineSentinelBot");

  // 1. Boot the Sentinel Bot Loop
  PipelineSentinelBot.startSentinel();

  // 2. Handle Graceful Shutdown Signals (Production Best Practice)
  const handleShutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(
      `\n[SENTINEL CLI] Received ${signal}. Shutting down sentinel daemon gracefully...`,
    );
    try {
      PipelineSentinelBot.stopSentinel();
    } catch (err) {
      console.error(
        "[SENTINEL CLI] stop error",
        err instanceof Error ? err.message : err,
      );
    }
    process.exit(0);
  };

  process.on("SIGINT", () => handleShutdown("SIGINT"));
  process.on("SIGTERM", () => handleShutdown("SIGTERM"));

  // Keep process alive (interval + stdin for interactive terminals).
  try {
    process.stdin.resume();
  } catch {
    /* non-interactive / PM2 — interval keeps the event loop alive */
  }
}

main().catch((error) => {
  console.error(
    "[SENTINEL CLI] fatal",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
