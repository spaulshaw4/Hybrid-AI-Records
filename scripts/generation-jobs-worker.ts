/**
 * Isolated generation-jobs worker (cloud-native).
 *
 * Runs outside the HTTP request path so ingress never times out waiting on the
 * shared upstream API key. Processes `generation_queue` jobs sequentially.
 *
 * Usage:
 *   npx tsx scripts/generation-jobs-worker.ts
 *
 * Tip: set GENERATION_QUEUE_WORKER=external (or 0) on the web process so only
 * this script drains the queue.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env" });

async function main() {
  const { runGenerationJobsWorkerForever } = await import(
    "../src/lib/generation-queue-worker.server"
  );
  await runGenerationJobsWorkerForever();
}

main().catch((error) => {
  console.error(
    "[generation-jobs-worker] fatal",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
});
