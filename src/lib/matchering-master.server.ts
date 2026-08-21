/**
 * Server-only: mix Hybrid Engine stems, Matchering 2.0 master, LUFS finish.
 * Failures never throw to the generator — the raw stem URL is returned instead.
 */
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { AUDIO_VAULT_BUCKET, STUDIO_AUDIO_BUCKET, vaultMimeType } from "@/lib/audio-vault";
import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import {
  MATCHERING_MIX_TIMEOUT_MS,
  MATCHERING_PIPELINE_TIMEOUT_MS,
  MATCHERING_PROCESS_TIMEOUT_MS,
  MATCHERING_REFERENCE_RELATIVE,
  MATCHERING_SCRIPT_RELATIVE,
  buildHybridMixArgs,
  collectHybridStems,
  matcheringFinishArgs,
  matcheringPythonArgs,
  masteredPlayablePath,
  masteredPcmPath,
  type HybridStemInputs,
} from "@/lib/matchering";

const execFileAsync = promisify(execFile);
const SIGNED_URL_TTL = 60 * 60 * 24 * 365;

export type MixAndMasterResult = {
  masterUrl: string | null;
  matched: boolean;
  mixed: boolean;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  try {
    await execFileAsync("ffmpeg", args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") throw new Error("FFmpeg is not installed on this host.");
    const detail = (err.stderr || err.message || "unknown FFmpeg error").toString().slice(0, 800);
    throw new Error(`FFmpeg failed: ${detail}`);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function resolveMatcheringReferencePath(cwd: string = process.cwd()): string | null {
  const fromEnv = process.env.MATCHERING_REFERENCE_PATH?.trim();
  if (fromEnv) return fromEnv;
  return join(cwd, MATCHERING_REFERENCE_RELATIVE);
}

async function downloadStem(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Could not download a stem (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("A stem file was empty.");
  await writeFile(dest, bytes);
}

async function runMatcheringPython(input: {
  scriptPath: string;
  target: string;
  reference: string;
  outWav: string;
}): Promise<boolean> {
  const scriptArgs = matcheringPythonArgs(input);
  const binaries: Array<{ bin: string; prefix: string[] }> = [
    ...(process.env.MATCHERING_PYTHON
      ? [{ bin: process.env.MATCHERING_PYTHON, prefix: [] as string[] }]
      : []),
    { bin: "python3", prefix: [] },
    { bin: "python", prefix: [] },
    { bin: "py", prefix: ["-3"] },
  ];

  for (const candidate of binaries) {
    try {
      await execFileAsync(candidate.bin, [...candidate.prefix, ...scriptArgs], {
        timeout: MATCHERING_PROCESS_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return true;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
      if (err.code === "ENOENT") continue;
      const exitCode = typeof err.code === "number" ? err.code : undefined;
      if (exitCode === 2 || /matchering is not installed/i.test(err.stderr ?? "")) {
        console.warn("[matchering] Python package missing — using FFmpeg loudnorm fallback");
        return false;
      }
      console.warn(
        "[matchering] process failed",
        err.stderr || err.message,
      );
      return false;
    }
  }
  console.warn("[matchering] Python runtime not found — using FFmpeg loudnorm fallback");
  return false;
}

async function uploadMasteredBytes(
  bytes: Uint8Array,
  path: string,
  fileType: "wav" | "mp3",
): Promise<string> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const mimeType = vaultMimeType(fileType);
  const buckets = [AUDIO_VAULT_BUCKET, STUDIO_AUDIO_BUCKET];
  let lastError: unknown = null;
  for (const bucket of buckets) {
    const { error } = await supabaseAdmin.storage.from(bucket).upload(path, bytes, {
      contentType: mimeType,
      upsert: true,
      cacheControl: "31536000",
    });
    if (error) {
      lastError = error;
      continue;
    }
    const { data, error: signError } = await supabaseAdmin.storage
      .from(bucket)
      .createSignedUrl(path, SIGNED_URL_TTL);
    if (!signError && data?.signedUrl) return data.signedUrl;
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("The mastered track could not be saved to storage.");
}

async function mixAndMasterOnce(options: {
  introUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  userId: string;
  taskId: string;
}): Promise<MixAndMasterResult> {
  const tmp = await mkdtemp(join(tmpdir(), "hybrid-matchering-"));
  const introPath = join(tmp, "intro.bin");
  const instrumentalPath = join(tmp, "instrumental.bin");
  const vocalPath = join(tmp, "vocal.bin");
  const mixPath = join(tmp, "mix.wav");
  const matchedPath = join(tmp, "matched.wav");
  const playablePath = join(tmp, "master.mp3");

  try {
    const downloads: Array<Promise<void>> = [];
    if (options.introUrl) downloads.push(downloadStem(options.introUrl, introPath));
    if (options.instrumentalUrl) downloads.push(downloadStem(options.instrumentalUrl, instrumentalPath));
    if (options.vocalUrl) downloads.push(downloadStem(options.vocalUrl, vocalPath));
    if (downloads.length === 0) return { masterUrl: null, matched: false, mixed: false };
    await Promise.all(downloads);

    const stems: HybridStemInputs = {
      introPath: options.introUrl ? introPath : undefined,
      instrumentalPath: options.instrumentalUrl ? instrumentalPath : undefined,
      vocalPath: options.vocalUrl ? vocalPath : undefined,
    };
    if (collectHybridStems(stems).length === 0) {
      return { masterUrl: null, matched: false, mixed: false };
    }

    await runFfmpeg(buildHybridMixArgs(stems, mixPath), MATCHERING_MIX_TIMEOUT_MS);

    const cwd = process.cwd();
    const reference = resolveMatcheringReferencePath(cwd);
    let masteredWav = mixPath;
    let matched = false;
    if (reference && (await fileExists(reference))) {
      matched = await runMatcheringPython({
        scriptPath: join(cwd, MATCHERING_SCRIPT_RELATIVE),
        target: mixPath,
        reference,
        outWav: matchedPath,
      });
      if (matched && (await fileExists(matchedPath))) masteredWav = matchedPath;
    } else {
      console.warn(
        `[matchering] no reference at ${MATCHERING_REFERENCE_RELATIVE} — skip Matchering, loudnorm only`,
      );
    }

    await runFfmpeg(matcheringFinishArgs(masteredWav, playablePath), MATCHERING_MIX_TIMEOUT_MS);

    const mp3 = await readFile(playablePath);
    const wav = await readFile(masteredWav).catch(() => null);
    const playableObject = masteredPlayablePath(options.userId, options.taskId);
    const masterUrl = await uploadMasteredBytes(new Uint8Array(mp3), playableObject, "mp3");
    if (wav && wav.byteLength > 1024) {
      await uploadMasteredBytes(
        new Uint8Array(wav),
        masteredPcmPath(options.userId, options.taskId),
        "wav",
      ).catch((error) => {
        console.warn(
          "[matchering] PCM24 vault upload skipped",
          error instanceof Error ? error.message : error,
        );
      });
    }

    return { masterUrl, matched, mixed: true };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Mix intro + instrumental + vocals, Matchering-master, upload to mastered_tracks/.
 * Always resolves: on timeout or tool failure, masterUrl is null so the caller
 * can keep the raw stem.
 */
export async function mixAndMasterHybridTrack(options: {
  introUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  userId: string;
  taskId: string;
}): Promise<MixAndMasterResult> {
  try {
    return await withTimeout(
      mixAndMasterOnce(options),
      MATCHERING_PIPELINE_TIMEOUT_MS,
      "Matchering pipeline",
    );
  } catch (error) {
    console.warn(
      "[matchering] pipeline skipped",
      error instanceof Error ? error.message : error,
    );
    return { masterUrl: null, matched: false, mixed: false };
  }
}

export const HYBRID_MIX_INTRO_SECONDS = HYBRID_INTRO_SECONDS;
