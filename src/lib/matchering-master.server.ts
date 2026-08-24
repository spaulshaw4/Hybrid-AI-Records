/**
 * Server-only: mix Hybrid Engine stems, Matchering 2.0 master, LUFS finish.
 * Failures never throw to the generator — the raw stem URL is returned instead.
 */
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import {
  MATCHERING_MIX_TIMEOUT_MS,
  MATCHERING_PIPELINE_TIMEOUT_MS,
  MATCHERING_PROCESS_TIMEOUT_MS,
  MATCHERING_REFERENCE_RELATIVE,
  MATCHERING_SCRIPT_RELATIVE,
  buildHybridMixArgs,
  collectHybridStems,
  hybridMixIncludesLoudnorm,
  matcheringFinishArgs,
  MASTER_FADE_OUT_SECONDS,
  matcheringPythonArgs,
  masteredPlayablePath,
  masteredPcmPath,
  type HybridStemInputs,
} from "@/lib/matchering";
import { readEnv } from "@/lib/env";
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      console.error(`[Gate 5] FFmpeg timed out after ${timeoutMs}ms — killing child`);
      killMatcheringChild(child);
      finish(new Error(`FFmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        finish(new Error("FFmpeg is not installed on this host."));
        return;
      }
      finish(error);
    });

    // Drain pipes so a full buffer never blocks the child.
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString("utf8");
    });
    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);

    child.on("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = (stderr || signal || `exit ${code}`).toString().slice(0, 800);
      finish(new Error(`FFmpeg failed: ${detail}`));
    });
  });
}

/** Probe WAV/MP3 duration so the finish pass can fade the last 4 seconds. */
async function probeAudioDurationSeconds(path: string): Promise<number | null> {
  try {
    const seconds = await new Promise<number | null>((resolve) => {
      const child = spawn(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let settled = false;
      const done = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        killMatcheringChild(child);
        done(null);
      }, 15_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", () => undefined);
      child.on("error", () => done(null));
      child.on("close", (code) => {
        if (code !== 0) {
          done(null);
          return;
        }
        const parsed = Number.parseFloat(stdout.trim());
        done(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      });
    });
    return seconds;
  } catch {
    return null;
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
  const fromEnv = readEnv("MATCHERING_REFERENCE_PATH");
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
  const { writeAtomicAudioFile, waitForFileUnlock } = await import("@/lib/track-lock.server");
  await writeAtomicAudioFile(dest, Buffer.from(bytes));
  await waitForFileUnlock(dest);
}

async function runMatcheringPython(input: {
  scriptPath: string;
  target: string;
  reference: string;
  outWav: string;
}): Promise<boolean> {
  const scriptArgs = matcheringPythonArgs(input);
  const pythonFromEnv = readEnv("MATCHERING_PYTHON");
  const binaries: Array<{ bin: string; prefix: string[] }> = [
    ...(pythonFromEnv ? [{ bin: pythonFromEnv, prefix: [] as string[] }] : []),
    { bin: "python3", prefix: [] },
    { bin: "python", prefix: [] },
    { bin: "py", prefix: ["-3"] },
  ];

  for (const candidate of binaries) {
    const ok = await spawnMatchering(candidate.bin, [...candidate.prefix, ...scriptArgs]);
    if (ok === "missing-bin") continue;
    return ok === "ok";
  }
  console.warn("[matchering] Python runtime not found — using FFmpeg loudnorm fallback");
  return false;
}

type MatcheringSpawnResult = "ok" | "fallback" | "missing-bin";

function spawnMatchering(bin: string, args: string[]): Promise<MatcheringSpawnResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: MatcheringSpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    console.log("[master] spawning Matchering 2.0");
    const child = spawn(bin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        finish("missing-bin");
        return;
      }
      console.warn("[matchering] process failed", err.message);
      finish("fallback");
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    const timer = setTimeout(() => {
      console.warn(
        `[matchering] ${MATCHERING_PROCESS_TIMEOUT_MS / 1000}s limit — aborting for FFmpeg loudnorm fallback`,
      );
      killMatcheringChild(child);
      finish("fallback");
    }, MATCHERING_PROCESS_TIMEOUT_MS);

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish("ok");
        return;
      }
      if (code === 2) {
        console.warn("[matchering] Python package missing — using FFmpeg loudnorm fallback");
        finish("fallback");
        return;
      }
      if (code === 3) {
        console.warn("[matchering] script hit the 30s cap — using FFmpeg loudnorm fallback");
        finish("fallback");
        return;
      }
      if (settled) return;
      console.warn("[matchering] process exited", code);
      finish("fallback");
    });
  });
}

function killMatcheringChild(child: ReturnType<typeof spawn>): void {
  if (child.pid && process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
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
  /** Requested track length; the master is cut and faded to it. */
  maxSeconds?: number;
  /** CWALO Gate 2 remux gains + optional section volume envelopes. */
  remuxGains?: {
    instrumentalVolume?: number;
    vocalVolume?: number;
    instrumentalVolumeExpr?: string | null;
    vocalVolumeExpr?: string | null;
  };
  /** CWALO section timestamps for Gate 5 fade / retention. */
  cwaloGuide?: {
    trackEnd?: number;
    outroStart?: number;
    fadeOutSeconds?: number;
    sectionCount?: number;
  };
}): Promise<MixAndMasterResult> {
  const tmp = await mkdtemp(join(tmpdir(), "hybrid-matchering-"));
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
  const matchedPath = join(tmp, "matched.wav");
  const playablePath = join(tmp, "master.mp3");

  try {
    const { logPipelineStep, logPipelineStepError } = await import("@/lib/pipeline-steps.server");
    logPipelineStep("mastering");
    const downloads: Array<Promise<void>> = [];
    if (options.introUrl) downloads.push(downloadStem(options.introUrl, introPath));
    if (options.instrumentalUrl) downloads.push(downloadStem(options.instrumentalUrl, instrumentalPath));
    if (options.vocalUrl) downloads.push(downloadStem(options.vocalUrl, vocalPath));
    if (downloads.length === 0) return { masterUrl: null, matched: false, mixed: false };
    console.log("[master] downloading stems");
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

    const remuxLoudnorm = hybridMixIncludesLoudnorm(stems);
    console.log("[master] Mixing audio stems (FFmpeg)...", {
      remux: options.remuxGains ?? { instrumentalVolume: 1.0, vocalVolume: 1.0 },
      dynamicRemux: Boolean(options.remuxGains?.instrumentalVolumeExpr),
      cwaloGuide: options.cwaloGuide ?? null,
      loudnormInMix: remuxLoudnorm,
    });
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
    } catch (mixError) {
      await cleanupAudioWriteResidue(mixPath);
      // Section-aware remux failed — retry with static master filter when both stems exist.
      if (stems.instrumentalPath && stems.vocalPath) {
        console.warn(
          "[Fallback Triggered] Section-aware remux failed — applying STATIC_MASTER_FFMPEG_FILTER",
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
      } else {
        throw mixError;
      }
    }

    const cwd = process.cwd();
    const reference = resolveMatcheringReferencePath(cwd);
    let masteredWav = mixPath;
    let matched = false;

    // Preferred path: upload premaster to Supabase, Matchering on Replicate with
    // REPLICATE_API_TOKEN + reachable HTTPS URIs (never local disk paths).
    try {
      const premasterBytes = new Uint8Array(await readFile(mixPath));
      const { matcheringFromPremasterBytes } = await import(
        "@/lib/replicate-matchering.server"
      );
      const replicateMasterUrl = await matcheringFromPremasterBytes({
        premasterWav: premasterBytes,
        userId: options.userId,
        taskId: options.taskId,
      });
      if (replicateMasterUrl) {
        console.log("[master] Replicate Matchering succeeded — downloading master");
        await downloadStem(replicateMasterUrl, matchedPath);
        if (await fileExists(matchedPath)) {
          masteredWav = matchedPath;
          matched = true;
          console.log("[master] Replicate Matchering 2.0 finished");
        }
      }
    } catch (replicateError) {
      console.warn(
        "[master] Replicate Matchering failed — trying local / FFmpeg fallback",
        replicateError instanceof Error ? replicateError.message : replicateError,
      );
    }

    if (!matched && reference && (await fileExists(reference))) {
      console.log("[master] Running local Matchering 2.0 mastering pass...");
      matched = await runMatcheringPython({
        scriptPath: join(cwd, MATCHERING_SCRIPT_RELATIVE),
        target: mixPath,
        reference,
        outWav: matchedPath,
      });
      if (matched && (await fileExists(matchedPath))) {
        masteredWav = matchedPath;
        console.log("[master] Matchering 2.0 finished");
      } else {
        console.warn("[master] Local Matchering skipped — applying FFmpeg finish filter");
      }
    } else if (!matched) {
      console.warn(
        `[matchering] no Replicate/local reference at ${MATCHERING_REFERENCE_RELATIVE} — skip Matchering`,
      );
    }

    // Gate 6 finalize: Resemble Enhance (pinned version) on the premaster /
    // matched WAV — public HTTPS upload, REPLICATE_API_TOKEN, poll to succeeded.
    const enhancedPath = join(tmp, "enhanced.wav");
    try {
      const sourceBytes = new Uint8Array(await readFile(masteredWav));
      const { enhancePremasterBytes } = await import(
        "@/lib/replicate-resemble-enhance.server"
      );
      const enhancedUrl = await enhancePremasterBytes({
        premasterWav: sourceBytes,
        userId: options.userId,
        taskId: options.taskId,
        denoise: true,
      });
      console.log("[master] Resemble Enhance succeeded — downloading enhanced master");
      await downloadStem(enhancedUrl, enhancedPath);
      if (await fileExists(enhancedPath)) {
        masteredWav = enhancedPath;
        matched = true;
        console.log("[master] Resemble Enhance finished — ready for FFmpeg LUFS finish");
      }
    } catch (enhanceError) {
      console.warn(
        "[master] Resemble Enhance failed — continuing with FFmpeg finish on premaster",
        enhanceError instanceof Error ? enhanceError.message : enhanceError,
      );
    }

    // Always finish with deterministic EBU R128 (-14 LUFS / -1.0 dBFS).
    // Dynamic Matchering / Enhance may shape the mix; loudnorm is never skipped.
    if (!matched) {
      console.warn(
        "[Gate 6] Dynamic enhance unavailable — applying static EBU R128 loudnorm=I=-14:LRA=7:tp=-1.0",
      );
    }
    console.log("[master] applying deterministic FFmpeg EBU R128 mastering filter (-14 LUFS / -1.0 dBFS)");
    const fadeSecs = options.cwaloGuide?.fadeOutSeconds ?? MASTER_FADE_OUT_SECONDS;
    const trackEnd = options.cwaloGuide?.trackEnd;
    const probedDuration =
      (options.maxSeconds && options.maxSeconds > fadeSecs) ||
      (trackEnd != null && trackEnd > fadeSecs)
        ? null
        : await probeAudioDurationSeconds(masteredWav);
    console.log("[master] tail fade-out", {
      maxSeconds: options.maxSeconds ?? null,
      trackEnd: trackEnd ?? null,
      outroStart: options.cwaloGuide?.outroStart ?? null,
      durationSeconds: probedDuration,
      fadeOutSeconds: fadeSecs,
      note: "fade anchored at CWALO track_end when present — never at outro_start",
    });
    await produceAtomicAudioFile(playablePath, async (tmpPlayable) => {
      await runFfmpeg(
        matcheringFinishArgs(masteredWav, tmpPlayable, options.maxSeconds, {
          // Always apply GATE_6_EBU_R128_MASTERING_FILTER (never skip).
          skipLoudnorm: false,
          durationSeconds: probedDuration ?? undefined,
          trackEnd: trackEnd ?? undefined,
          fadeOutSeconds: fadeSecs,
        }),
        MATCHERING_MIX_TIMEOUT_MS,
      );
    });
    await waitForFileUnlock(playablePath);

    const mp3 = await readFile(playablePath);
    const wav = await readFile(masteredWav).catch(() => null);
    const playableObject = masteredPlayablePath(options.userId, options.taskId);
    console.log("[master] Uploading to vault & preparing player...");
    const masterUrl = assertMasteringContractOutput(
      await uploadMasteredBytes(new Uint8Array(mp3), playableObject, "mp3"),
    ).masteredAudioUrl;
    logPostConditionPassed("Mastered audio ready");
    recordPipelineSuccess("mastering");
    console.log("[master] vault upload ready", playableObject);
    try {
      const { completeGenerationTask } = await import("@/lib/engine-pipeline.server");
      await completeGenerationTask({
        taskId: options.taskId,
        userId: options.userId,
        audioUrl: masterUrl,
      });
    } catch (error) {
      console.warn(
        "[master] generation_tasks completion skipped",
        error instanceof Error ? error.message : error,
      );
    }
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
    try {
      const { unregisterWorkerTempPath } = await import("@/lib/pipeline-worker.server");
      unregisterWorkerTempPath(tmp);
    } catch {
      /* ignore */
    }
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
  logPreConditionPassed("mastering", "stem URLs present");
  try {
    return await withTimeout(
      mixAndMasterOnce(options),
      MATCHERING_PIPELINE_TIMEOUT_MS,
      "Matchering pipeline",
    );
  } catch (error) {
    recordPipelineFailure("mastering", error);
    const { logPipelineStepError } = await import("@/lib/pipeline-steps.server");
    logPipelineStepError("mastering", error);
    if (shouldRethrowPipelineControlError(error)) throw error;
    // Remux / encode failures must surface — returning a null master hides the
    // real FFmpeg error behind "did not produce a playable master".
    const message = error instanceof Error ? error.message : String(error ?? "");
    if (
      /FFmpeg|timed out|not installed|Sample rate|GATE_4|remux|empty/i.test(message)
    ) {
      throw error instanceof Error ? error : new Error(message);
    }
    console.warn("[matchering] pipeline skipped", message);
    return { masterUrl: null, matched: false, mixed: false };
  }
}

export const HYBRID_MIX_INTRO_SECONDS = HYBRID_INTRO_SECONDS;
