/**
 * Resumable Demucs batch over `.ingest_vault` MP3s, with retries.
 *
 * Usage:
 *   npx tsx scripts/batch-separate.ts
 *
 * Progress: `.ingest_vault/completed_stems.json`. Stop and rerun anytime.
 *
 * Uses ryan5453/demucs (studio pipeline). Do not pin
 * 2e1dddc8621f72155f24cf2e0adbde548458d3cab9f00c0139eea840d0ac4746 —
 * that hash is an image model.
 */
import { config } from "dotenv";
import Replicate from "replicate";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

config({ path: ".env.local" });
config({ path: ".env" });

const VAULT_DIR = resolve(process.cwd(), ".ingest_vault");
const LOG_FILE = resolve(process.cwd(), ".ingest_vault/completed_stems.json");
const DEMUCS_MODEL =
  "ryan5453/demucs:5a7041cc9b82e5a558fea6b3d7b12dea89625e89da33f0447bd727c2d0ab9e77";

const replicate = new Replicate();

type CompletedLog = Record<
  string,
  {
    processed_at: string;
    stems: Record<string, string | undefined>;
  }
>;

function stemUrl(value: unknown): string | undefined {
  if (typeof value === "string" && (value.startsWith("http") || value.startsWith("data:"))) {
    return value;
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (value && typeof value === "object") {
    if (typeof (value as { toString?: () => string }).toString === "function") {
      const asString = String(value);
      if (asString.startsWith("http") || asString.startsWith("data:")) return asString;
    }
    if ("url" in value) {
      const url = (value as { url: unknown }).url;
      const resolved = typeof url === "function" ? url.call(value) : url;
      if (resolved instanceof URL) return resolved.toString();
      if (typeof resolved === "string" && (resolved.startsWith("http") || resolved.startsWith("data:"))) {
        return resolved;
      }
    }
  }
  return undefined;
}

function jsonSafeStems(output: unknown): Record<string, string | undefined> {
  if (!output || typeof output !== "object") return {};
  const stems: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    stems[key] = stemUrl(value);
  }
  return stems;
}

function getCompleted(): CompletedLog {
  if (existsSync(LOG_FILE)) {
    return JSON.parse(readFileSync(LOG_FILE, "utf-8")) as CompletedLog;
  }
  return {};
}

function saveCompleted(completed: CompletedLog) {
  writeFileSync(LOG_FILE, JSON.stringify(completed, null, 2));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function separateWithRetry(fileBuffer: Buffer, maxRetries = 5): Promise<unknown> {
  let attempt = 0;
  let delay = 3000;
  while (attempt < maxRetries) {
    try {
      return await replicate.run(DEMUCS_MODEL, {
        input: {
          audio: `data:audio/mpeg;base64,${fileBuffer.toString("base64")}`,
          stem: "none",
          output_format: "mp3",
        },
      });
    } catch (err) {
      attempt++;
      console.warn(`[Retry ${attempt}/${maxRetries}] Worker busy or error: ${errorMessage(err)}`);
      if (attempt >= maxRetries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
  throw new Error("separateWithRetry exhausted without a result");
}

async function runLargeScaleBatch() {
  if (!process.env.REPLICATE_API_TOKEN?.trim() && !process.env.REPLICATE_API_KEY?.trim()) {
    console.error("Missing REPLICATE_API_TOKEN in .env.local or .env");
    process.exit(1);
  }
  if (!existsSync(VAULT_DIR)) {
    console.error("No .ingest_vault directory. Harvest audio first.");
    process.exit(1);
  }

  const completed = getCompleted();
  const allFiles = readdirSync(VAULT_DIR).filter((f) => f.toLowerCase().endsWith(".mp3"));
  const queue = allFiles.filter((f) => !completed[f]);

  console.log("=== Ingest Pipeline Status ===");
  console.log(`Total MP3s in vault: ${allFiles.length}`);
  console.log(`Already processed:   ${Object.keys(completed).length}`);
  console.log(`Remaining in queue:  ${queue.length}\n`);

  for (let i = 0; i < queue.length; i++) {
    const filename = queue[i]!;
    const filePath = join(VAULT_DIR, filename);
    console.log(`[${i + 1}/${queue.length}] Processing: ${filename}`);
    try {
      const fileBuffer = readFileSync(filePath);
      const output = await separateWithRetry(fileBuffer);
      completed[filename] = {
        processed_at: new Date().toISOString(),
        stems: jsonSafeStems(output),
      };
      saveCompleted(completed);
      console.log(`Completed: ${filename}`);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      console.error(`Skipped ${filename} after retries:`, err);
    }
  }

  console.log("\nQueue run finished!");
}

runLargeScaleBatch().catch((error) => {
  console.error(error);
  process.exit(1);
});
