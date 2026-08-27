/**
 * Local Demucs stem split for the first MP3 in `.ingest_vault`.
 *
 * Usage:
 *   npx tsx scripts/separate-stem.ts
 *
 * Uses REPLICATE_API_TOKEN from .env.local / .env. Stem files stay in
 * `.ingest_vault/stems/` (gitignored).
 */
import { config } from "dotenv";
import Replicate from "replicate";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { basename, join, parse, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

config({ path: ".env.local" });
config({ path: ".env" });

const VAULT_DIR = resolve(process.cwd(), ".ingest_vault");
const STEM_DIR = join(VAULT_DIR, "stems");
/** Latest cjwbw/demucs version. The previously pinned hash is an image model. */
const DEMUCS_MODEL =
  "cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953";

const replicate = new Replicate();

type StemName = "drums" | "bass" | "vocals" | "other";

function stemUrl(value: unknown): string | undefined {
  if (typeof value === "string" && value.startsWith("http")) return value;
  if (value && typeof value === "object" && "url" in value) {
    const url = (value as { url: unknown }).url;
    if (typeof url === "function") {
      const resolved = url.call(value);
      if (typeof resolved === "string" && resolved.startsWith("http")) return resolved;
    }
    if (typeof url === "string" && url.startsWith("http")) return url;
  }
  return undefined;
}

async function saveStem(url: string, destination: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download stem ${url} (${response.status})`);
  }
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream),
    createWriteStream(destination),
  );
}

async function runDemucs() {
  if (!process.env.REPLICATE_API_TOKEN?.trim() && !process.env.REPLICATE_API_KEY?.trim()) {
    console.error("Missing REPLICATE_API_TOKEN in .env.local or .env");
    process.exit(1);
  }

  if (!existsSync(VAULT_DIR)) {
    console.error("No .ingest_vault directory. Harvest audio first.");
    process.exit(1);
  }

  const files = readdirSync(VAULT_DIR).filter((f) => f.toLowerCase().endsWith(".mp3"));
  if (files.length === 0) {
    console.error("No MP3 files found in .ingest_vault");
    return;
  }

  const targetFile = files[0]!;
  const filePath = join(VAULT_DIR, targetFile);
  console.log(`Processing vault track: ${targetFile}...`);

  const fileBuffer = readFileSync(filePath);
  const output = (await replicate.run(DEMUCS_MODEL, {
    input: {
      audio: `data:audio/mpeg;base64,${fileBuffer.toString("base64")}`,
      stem: "none",
      output_format: "mp3",
    },
  })) as Record<string, unknown>;

  const stems: Record<StemName, string | undefined> = {
    drums: stemUrl(output.drums),
    bass: stemUrl(output.bass),
    vocals: stemUrl(output.vocals),
    other: stemUrl(output.other),
  };

  console.log("\n--- Demucs Stem Outputs ---");
  console.log("Drums:", stems.drums ?? "(none)");
  console.log("Bass:", stems.bass ?? "(none)");
  console.log("Vocals:", stems.vocals ?? "(none)");
  console.log("Other:", stems.other ?? "(none)");

  const outDir = join(STEM_DIR, parse(targetFile).name);
  mkdirSync(outDir, { recursive: true });

  for (const [name, url] of Object.entries(stems) as [StemName, string | undefined][]) {
    if (!url) continue;
    const dest = join(outDir, `${name}${extFromUrl(url)}`);
    await saveStem(url, dest);
    console.log(`Saved ${name} → ${dest}`);
  }
}

function extFromUrl(url: string): string {
  try {
    const ext = basename(new URL(url).pathname).match(/\.(mp3|wav|flac|ogg)$/i)?.[0];
    return ext?.toLowerCase() ?? ".mp3";
  } catch {
    return ".mp3";
  }
}

runDemucs().catch((error) => {
  console.error(error);
  process.exit(1);
});
