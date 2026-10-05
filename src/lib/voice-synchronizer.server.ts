import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const execAsync = promisify(exec);

export interface SyncOptions {
  inputPath: string;
  outputPath: string;
  bpm: number;
  key?: string;
}

export interface SyncResult {
  synchronizedAudioPath: string;
  durationSeconds: number;
  totalBars: number;
  promptMetadata: string;
}

export async function synchronizeVocal(options: SyncOptions): Promise<SyncResult> {
  const { inputPath, outputPath, bpm, key } = options;
  const tempTrimmed = outputPath.replace(/\.wav$/, "_trimmed.wav");
  try {
    const ffmpegCmd = `ffmpeg -y -i "${inputPath}" -af "silenceremove=start_periods=1:start_duration=0.05:start_threshold=-45dB,loudnorm=I=-16:TP=-1.0:LRA=11" -c:a pcm_s16le -ar 44100 "${tempTrimmed}"`;
    await execAsync(ffmpegCmd);
    const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tempTrimmed}"`;
    const { stdout: durStdout } = await execAsync(probeCmd);
    const rawDuration = parseFloat(durStdout.trim()) || 0;
    const secondsPerBeat = 60 / bpm;
    const secondsPerBar = secondsPerBeat * 4;
    const targetBars = Math.max(1, Math.round(rawDuration / secondsPerBar));
    const targetDuration = targetBars * secondsPerBar;
    const padDuration = Math.max(0, targetDuration - rawDuration);
    const finalCmd = `ffmpeg -y -i "${tempTrimmed}" -af "apad=pad_dur=${padDuration.toFixed(3)}" -t ${targetDuration.toFixed(3)} -c:a pcm_s16le "${outputPath}"`;
    await execAsync(finalCmd);
    await fs.unlink(tempTrimmed).catch(() => {});
    const promptMetadata = `[Tempo: ${bpm} BPM]${key ? ` [Key: ${key}]` : ""} [Meter: 4/4] [Vocal Length: ${targetBars} bars]`;
    return {
      synchronizedAudioPath: outputPath,
      durationSeconds: targetDuration,
      totalBars: targetBars,
      promptMetadata,
    };
  } catch (error) {
    console.error("[VoiceSynchronizer] Processing failed, falling back to raw audio:", error);
    await fs.copyFile(inputPath, outputPath);
    return {
      synchronizedAudioPath: outputPath,
      durationSeconds: 0,
      totalBars: 0,
      promptMetadata: `[Tempo: ${bpm} BPM]`,
    };
  }
}

export function mapKeyToAutotuneScale(keyString?: string): string {
  if (!keyString) return "closest";
  const clean = keyString.trim().toLowerCase();
  const match = clean.match(/^([a-g][b#]?)\s*(major|minor|maj|min)?$/i);
  if (!match) return "closest";
  const note = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  const isMinor = match[2] && (match[2].startsWith("min") || match[2] === "m");
  const mode = isMinor ? "min" : "maj";
  return `${note}:${mode}`;
}
