/**
 * Local production cluster — spawns worker + sentinel without `concurrently`.
 * Prefer `npm run production:cluster` (concurrently) when installed;
 * this script is the zero-extra-dep fallback: `npm run production:cluster:node`
 */

import { spawn, type ChildProcess } from "node:child_process";

const children: ChildProcess[] = [];

function start(name: string, script: string): ChildProcess {
  const child = spawn("npx", ["tsx", script], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, GENERATION_QUEUE_WORKER: "external" },
  });
  child.on("exit", (code, signal) => {
    console.log(`[cluster] ${name} exited`, { code, signal });
    shutdown("child-exit");
  });
  children.push(child);
  return child;
}

function shutdown(reason: string) {
  console.log(`[cluster] shutting down (${reason})`);
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

console.log("[cluster] starting worker + sentinel");
start("worker", "scripts/generation-jobs-worker.ts");
start("sentinel", "scripts/run-sentinel.ts");
