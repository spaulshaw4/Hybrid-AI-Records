/**
 * Persist a fan-token purchase as Status = 'Pending Payout' in master_catalog.db.
 * Uses the Python ledger helper (parameterized SQL). Never sends money.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type { TokenPurchasedPayload } from "@/lib/fan-token-purchase";

function pythonBin(): string {
  const envBin =
    process.env.PYTHON?.trim() ||
    process.env.PYTHON312?.trim() ||
    process.env.PYTHON_PATH?.trim();
  if (envBin) return envBin;
  const local = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "Python", "Python312", "python.exe")
    : "";
  if (local && existsSync(local)) return local;
  return "python";
}

function catalogDbPath(): string {
  return (
    process.env.MASTER_CATALOG_DB?.trim() ||
    "D:\\MusicDatasets\\database\\master_catalog.db"
  );
}

export async function recordPendingPayout(
  payload: TokenPurchasedPayload,
): Promise<{ inserted: boolean }> {
  const script = path.resolve(process.cwd(), "scripts", "pending_payouts.py");
  const dbPath = catalogDbPath();
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn(pythonBin(), [script, "--db", dbPath], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(stderr.trim() || `pending_payouts.py exited ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin.end(JSON.stringify(payload));
  });

  try {
    const parsed = JSON.parse(raw || "{}") as { ok?: boolean; inserted?: boolean };
    return { inserted: Boolean(parsed.ok && parsed.inserted) };
  } catch {
    console.error("pending_payouts.py returned non-JSON");
    return { inserted: false };
  }
}
