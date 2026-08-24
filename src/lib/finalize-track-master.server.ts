import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  GATE_6_MASTER_EQ,
  finalizeTrackMasterArgs,
  gate6LocalMasterArgs,
  gate6MasterAfChain,
  loudnormFilter,
  loudnormTwoPassFilter,
  measureLoudnormArgs,
  parseLoudnormMeasurement,
} from "@/lib/loudnorm";

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;

function resolveFfmpegBin(): string {
  return process.env.FFMPEG_PATH?.trim() || process.env.FFMPEG_BINARY?.trim() || "ffmpeg";
}

async function runFfmpeg(args: string[]): Promise<string> {
  const bin = resolveFfmpegBin();
  try {
    const result = await execFileAsync(bin, args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (err.code === "ENOENT") {
      throw new Error("Mastering normalization failed: FFmpeg is not installed on this host.");
    }
    // Pass-1 null output still prints JSON on stderr even when execFile reports non-zero.
    const combined = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    if (parseLoudnormMeasurement(combined)) return combined;
    const detail = (err.stderr || err.message || "unknown FFmpeg error").toString().slice(0, 800);
    throw new Error(`Mastering normalization failed: ${detail}`);
  }
}

/**
 * Applies professional broadcast limiting and targets -14 LUFS integrated,
 * -1.0 dBTP, LRA 7 (EBU R128 two-pass when measurement succeeds).
 */
export async function finalizeTrackMaster(
  inputAudioPath: string,
  outputMasterPath: string,
): Promise<string> {
  const measuredLog = await runFfmpeg(measureLoudnormArgs(inputAudioPath));
  const measured = parseLoudnormMeasurement(measuredLog);
  const filter = measured ? loudnormTwoPassFilter(measured) : loudnormFilter();
  await runFfmpeg(finalizeTrackMasterArgs(inputAudioPath, outputMasterPath, filter));
  return outputMasterPath;
}

/**
 * Gate 6 local path: master EQ + two-pass EBU R128 loudnorm → 320 kbps MP3.
 * No Replicate, Matchering, or Resemble Enhance.
 */
export async function applyGate6LocalFfmpegMaster(
  inputAudioPath: string,
  outputMasterPath: string,
): Promise<{ mode: "two-pass" | "one-pass"; af: string }> {
  console.log("[Gate 6] Local FFmpeg master — EQ + two-pass loudnorm (-14 LUFS / -1.0 dBTP)", {
    eq: GATE_6_MASTER_EQ,
    ffmpeg: resolveFfmpegBin(),
  });
  const measuredLog = await runFfmpeg(
    measureLoudnormArgs(inputAudioPath, { withMasterEq: true }),
  );
  const measured = parseLoudnormMeasurement(measuredLog);
  if (measured) {
    const loudnormPart = loudnormTwoPassFilter(measured);
    const af = gate6MasterAfChain(loudnormPart);
    await runFfmpeg(gate6LocalMasterArgs(inputAudioPath, outputMasterPath, loudnormPart));
    console.log("[Gate 6] Two-pass loudnorm complete", { measured_I: measured.input_i });
    return { mode: "two-pass", af };
  }
  const loudnormPart = loudnormFilter();
  const af = gate6MasterAfChain(loudnormPart);
  console.warn("[Gate 6] Loudnorm measure JSON missing — one-pass EQ + loudnorm");
  await runFfmpeg(gate6LocalMasterArgs(inputAudioPath, outputMasterPath, loudnormPart));
  return { mode: "one-pass", af };
}

/**
 * Two-pass EBU R128 normalize a WAV in place (or to `outputWavPath`).
 * Falls back to one-pass `STATIC_EBU_R128_LOUDNORM` when measurement JSON is missing.
 */
export async function applyEbuR128TwoPass(
  inputWavPath: string,
  outputWavPath: string,
): Promise<{ mode: "two-pass" | "one-pass" }> {
  const { STATIC_EBU_R128_LOUDNORM } = await import("@/lib/loudnorm");
  const measuredLog = await runFfmpeg(measureLoudnormArgs(inputWavPath));
  const measured = parseLoudnormMeasurement(measuredLog);
  if (measured) {
    await runFfmpeg([
      "-y",
      "-hide_banner",
      "-nostdin",
      "-i",
      inputWavPath,
      "-af",
      loudnormTwoPassFilter(measured),
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s24le",
      outputWavPath,
    ]);
    return { mode: "two-pass" };
  }
  await runFfmpeg([
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputWavPath,
    "-af",
    STATIC_EBU_R128_LOUDNORM,
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s24le",
    outputWavPath,
  ]);
  return { mode: "one-pass" };
}

/**
 * Downloads a mix, loudnorm-masters it to 320 kbps, and archives the result.
 * Throws if FFmpeg is missing or the pass fails — callers should fall back.
 */
export async function finalizeArchivedMaster(options: {
  sourceUrl: string;
  userId: string;
  taskId: string;
}): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), "hybrid-master-"));
  const inputPath = join(tmp, "input.bin");
  const outputPath = join(tmp, "master.mp3");
  try {
    const response = await fetch(options.sourceUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error("Could not download the mix for mastering.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1024) throw new Error("The mix file was empty before mastering.");
    await writeFile(inputPath, bytes);
    await applyGate6LocalFfmpegMaster(inputPath, outputPath);
    const mastered = await readFile(outputPath);
    try {
      const { uploadMasterToVault } = await import("@/lib/audio-vault-upload.server");
      return await uploadMasterToVault(mastered, options.taskId, "mp3");
    } catch (error) {
      console.warn(
        "[audio-vault] master upload failed, falling back to studio archive",
        error instanceof Error ? error.message : error,
      );
    }
    const { archiveGeneratedAudioBytes } = await import("@/lib/apiframe.server");
    return archiveGeneratedAudioBytes(
      new Uint8Array(mastered),
      options.userId,
      options.taskId,
      "audio/mpeg",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
