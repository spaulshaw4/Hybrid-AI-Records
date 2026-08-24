/**
 * Gate 6 — 100% local FFmpeg mastering.
 *
 * Downloads Gate 2 (or remixed stem) audio, applies master EQ + two-pass
 * loudnorm (-14 LUFS / -1.0 dBTP), uploads the MP3 to Supabase vault.
 * No Replicate, Resemble Enhance, or Matchering.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import {
  MATCHERING_MIX_TIMEOUT_MS,
  MATCHERING_PIPELINE_TIMEOUT_MS,
  buildHybridMixArgs,
  collectHybridStems,
  masteredPlayablePath,
  type HybridStemInputs,
} from "@/lib/matchering";
import {
  assertPipelineBreakerClosed,
  recordPipelineFailure,
  recordPipelineSuccess,
} from "@/lib/pipeline-breaker";
import {
  assertMasteringContractOutput,
  logPostConditionPassed,
  logPreConditionPassed,
} from "@/lib/pipeline-contracts";
import { assertSampleRateGate } from "@/lib/studio-pipeline-gates";
import { shouldRethrowPipelineControlError } from "@/lib/studio-pipeline-error";

export type MixAndMasterResult = {
  masterUrl: string | null;
  /** Always false — Matchering removed from Gate 6. */
  matched: boolean;
  mixed: boolean;
  /** Set when mastering soft-skips so Gate 6 can surface the real cause. */
  failureReason?: string;
};

function formatMasteringError(error: unknown): string {
  if (error instanceof Error) {
    const cause =
      error.cause instanceof Error
        ? error.cause.message
        : error.cause != null
          ? String(error.cause)
          : "";
    return cause ? `${error.message} | cause=${cause}` : error.message;
  }
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error ?? "unknown mastering failure");
}

/** Prefer FFMPEG_PATH, then PATH lookup — avoids Windows `spawn UNKNOWN`. */
function resolveFfmpegBin(): string {
  const fromEnv = process.env.FFMPEG_PATH?.trim() || process.env.FFMPEG_BINARY?.trim();
  if (fromEnv) return fromEnv;
  return "ffmpeg";
}

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

function killFfmpegChild(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  child.kill("SIGKILL");
}

async function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  const bin = resolveFfmpegBin();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let settled = false;
    let stderr = "";
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };

    const timer = setTimeout(() => {
      console.error(`[Gate 6] FFmpeg timed out after ${timeoutMs}ms — killing child (${bin})`);
      killFfmpegChild(child);
      finish(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      console.error("[Gate 6] FFmpeg spawn error", {
        bin,
        code: err.code,
        message: err.message,
        ffmpegPath: process.env.FFMPEG_PATH || "(unset)",
      });
      finish(
        new Error(
          `FFmpeg spawn failed (${bin}): ${err.message}${err.code ? ` [${err.code}]` : ""}`,
        ),
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }
      finish(
        new Error(
          `FFmpeg exited ${code ?? "null"}: ${stderr.slice(-1200) || "(no stderr)"}`,
        ),
      );
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function downloadStem(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Could not download a stem (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 1024) throw new Error("A stem file was empty.");
  const { writeAtomicAudioFile, waitForFileUnlock } = await import("@/lib/track-lock.server");
  await writeAtomicAudioFile(dest, Buffer.from(bytes));
  await waitForFileUnlock(dest);
}

async function uploadMasteredBytes(
  bytes: Uint8Array,
  path: string,
  fileType: "wav" | "mp3",
): Promise<string> {
  const { uploadEngineMaster } = await import("@/lib/engine-pipeline.server");
  return uploadEngineMaster(bytes, path, fileType);
}

async function mixAndMasterOnce(options: {
  introUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  userId: string;
  taskId: string;
  maxSeconds?: number;
  remuxGains?: {
    instrumentalVolume?: number;
    vocalVolume?: number;
    instrumentalVolumeExpr?: string | null;
    vocalVolumeExpr?: string | null;
  };
  cwaloGuide?: {
    trackEnd?: number;
    outroStart?: number;
    fadeOutSeconds?: number;
    sectionCount?: number;
  };
}): Promise<MixAndMasterResult> {
  const tmp = await mkdtemp(join(tmpdir(), "hybrid-gate6-"));
  try {
    const { registerWorkerTempPathForTrack } = await import("@/lib/pipeline-worker.server");
    if (options.taskId) registerWorkerTempPathForTrack(options.taskId, tmp);
  } catch {
    /* worker module optional during isolated tests */
  }

  const introPath = join(tmp, "intro.bin");
  const instrumentalPath = join(tmp, "instrumental.bin");
  const vocalPath = join(tmp, "vocal.bin");
  const mixPath = join(tmp, "mix.wav");
  const playablePath = join(tmp, "master.mp3");

  try {
    const { logPipelineStep } = await import("@/lib/pipeline-steps.server");
    logPipelineStep("mastering");

    const downloads: Array<Promise<void>> = [];
    if (options.introUrl) downloads.push(downloadStem(options.introUrl, introPath));
    if (options.instrumentalUrl) {
      downloads.push(downloadStem(options.instrumentalUrl, instrumentalPath));
    }
    if (options.vocalUrl) downloads.push(downloadStem(options.vocalUrl, vocalPath));
    if (downloads.length === 0) {
      return { masterUrl: null, matched: false, mixed: false };
    }
    console.log("[Gate 6] Downloading Gate 2 / stem audio for local FFmpeg master");
    await Promise.all(downloads);

    const rateBuffers: Array<{ label: string; bytes: Uint8Array }> = [];
    if (options.instrumentalUrl && (await fileExists(instrumentalPath))) {
      rateBuffers.push({
        label: "instrumental",
        bytes: new Uint8Array(await readFile(instrumentalPath)),
      });
    }
    if (options.vocalUrl && (await fileExists(vocalPath))) {
      rateBuffers.push({
        label: "vocal",
        bytes: new Uint8Array(await readFile(vocalPath)),
      });
    }
    assertSampleRateGate(rateBuffers);

    const stems: HybridStemInputs = {
      introPath: options.introUrl ? introPath : undefined,
      instrumentalPath: options.instrumentalUrl ? instrumentalPath : undefined,
      vocalPath: options.vocalUrl ? vocalPath : undefined,
    };
    if (collectHybridStems(stems).length === 0) {
      return { masterUrl: null, matched: false, mixed: false };
    }

    // Multi-stem (experimental toggle): local remux only. Short path is a single URL.
    let sourceForMaster = options.instrumentalUrl
      ? instrumentalPath
      : options.vocalUrl
        ? vocalPath
        : introPath;

    const stemCount = collectHybridStems(stems).length;
    if (stemCount > 1) {
      console.log("[Gate 6] Local FFmpeg remux of stems before master EQ / loudnorm");
      const { produceAtomicAudioFile, waitForFileUnlock, cleanupAudioWriteResidue } = await import(
        "@/lib/track-lock.server"
      );
      try {
        await produceAtomicAudioFile(mixPath, async (tmpMix) => {
          await runFfmpeg(
            buildHybridMixArgs(stems, tmpMix, options.remuxGains),
            MATCHERING_MIX_TIMEOUT_MS,
          );
        });
        await waitForFileUnlock(mixPath);
        sourceForMaster = mixPath;
      } catch (mixError) {
        await cleanupAudioWriteResidue(mixPath);
        if (stems.instrumentalPath && stems.vocalPath) {
          console.warn(
            "[Gate 6] Section-aware remux failed — static local remux",
            mixError instanceof Error ? mixError.message : mixError,
          );
          const { buildStaticMasterFfmpegArgs } = await import("@/lib/pipeline-fallbacks.server");
          await produceAtomicAudioFile(mixPath, async (tmpMix) => {
            await runFfmpeg(
              buildStaticMasterFfmpegArgs(stems.instrumentalPath!, stems.vocalPath!, tmpMix),
              MATCHERING_MIX_TIMEOUT_MS,
            );
          });
          await waitForFileUnlock(mixPath);
          sourceForMaster = mixPath;
        } else {
          throw mixError;
        }
      }
    } else {
      console.log("[Gate 6] Single-source path — mastering Gate 2 vault audio directly");
    }

    void options.cwaloGuide;
    void options.maxSeconds;

    const { applyGate6LocalFfmpegMaster } = await import("@/lib/finalize-track-master.server");
    const { mode } = await applyGate6LocalFfmpegMaster(sourceForMaster, playablePath);
    console.log(`[Gate 6] Local FFmpeg master ready (${mode})`);

    const { waitForFileUnlock } = await import("@/lib/track-lock.server");
    await waitForFileUnlock(playablePath);

    const mp3 = await readFile(playablePath);
    const playableObject = masteredPlayablePath(options.userId, options.taskId);
    console.log("[Gate 6] Uploading mastered MP3 to Supabase vault…");
    const masterUrl = assertMasteringContractOutput(
      await uploadMasteredBytes(new Uint8Array(mp3), playableObject, "mp3"),
    ).masteredAudioUrl;
    logPostConditionPassed("Mastered audio ready");
    recordPipelineSuccess("mastering");
    console.log("[Gate 6] Vault upload ready", playableObject);

    try {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({
        taskId: options.taskId,
        userId: options.userId,
        audioUrl: masterUrl,
      });
    } catch (error) {
      console.warn(
        "[Gate 6] generation_tasks completion skipped",
        error instanceof Error ? error.message : error,
      );
    }

    return { masterUrl, matched: false, mixed: true };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    try {
      const { unregisterWorkerTempPath } = await import("@/lib/pipeline-worker.server");
      unregisterWorkerTempPath(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Gate 6 entry: local FFmpeg EQ + two-pass loudnorm + vault upload.
 * Always resolves with a master URL or throws with a concrete cause.
 */
export async function mixAndMasterHybridTrack(options: {
  introUrl?: string | null;
  instrumentalUrl?: string | null;
  vocalUrl?: string | null;
  userId: string;
  taskId: string;
  maxSeconds?: number;
  remuxGains?: {
    instrumentalVolume?: number;
    vocalVolume?: number;
    instrumentalVolumeExpr?: string | null;
    vocalVolumeExpr?: string | null;
  };
  cwaloGuide?: {
    trackEnd?: number;
    outroStart?: number;
    fadeOutSeconds?: number;
    sectionCount?: number;
  };
}): Promise<MixAndMasterResult> {
  assertPipelineBreakerClosed("mastering");
  if (!options.instrumentalUrl && !options.vocalUrl && !options.introUrl) {
    logPreConditionPassed("mastering", "no stems — skipped");
    return { masterUrl: null, matched: false, mixed: false };
  }
  logPreConditionPassed("mastering", "source audio URL present");
  try {
    return await withTimeout(
      mixAndMasterOnce(options),
      MATCHERING_PIPELINE_TIMEOUT_MS,
      "Gate 6 local FFmpeg master",
    );
  } catch (error) {
    recordPipelineFailure("mastering", error);
    const { logPipelineStepError } = await import("@/lib/pipeline-steps.server");
    logPipelineStepError("mastering", error);
    const detail = formatMasteringError(error);
    console.error("[Gate 6] mixAndMasterHybridTrack failed — surfacing exact cause:", detail);
    if (error instanceof Error && error.stack) {
      console.error("[Gate 6] stack:", error.stack.slice(0, 2000));
    }
    if (shouldRethrowPipelineControlError(error)) throw error;
    throw new Error(`[Gate 6] Mastering utility failed: ${detail}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

export const HYBRID_MIX_INTRO_SECONDS = HYBRID_INTRO_SECONDS;
