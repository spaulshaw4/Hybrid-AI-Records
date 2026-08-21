/**
 * Pre-flight audio validation (browser only).
 *
 * Runs BEFORE any lip-sync call, render dispatch or FFmpeg mux. Two layers:
 *
 *   1. Container header check — the first bytes of the file are sniffed so a
 *      renamed / truncated / zero-length "track" is caught locally instead of
 *      failing halfway through a paid render.
 *   2. Waveform check — the file is decoded once and reduced to duration,
 *      sample rate, channel count, peak / RMS levels, leading silence and a
 *      small peak array for display. A silent, clipped or offset master is the
 *      single most common cause of "the video is out of sync" reports.
 *
 * Nothing is uploaded: the file never leaves the browser during this check.
 */

/** Containers the render pipeline can decode and mux without re-encoding. */
export type AudioContainer = "wav" | "mp3" | "mp4" | "flac" | "ogg" | "unknown";

export type WaveformProfile = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  /** Absolute peak sample, 0–1. */
  peak: number;
  /** Root-mean-square level across the whole track, 0–1. */
  rms: number;
  /** Silence before the first audible sample — the mux starts at 0:00. */
  leadingSilenceSeconds: number;
  trailingSilenceSeconds: number;
  /** Fraction of samples sitting at full scale (digital clipping). */
  clippedRatio: number;
  /** ~120 normalised buckets for the inline waveform strip. */
  peaks: number[];
};

export type AudioPreflightReport = {
  /** False when something would break the sync/render job outright. */
  ok: boolean;
  fileName: string;
  bytes: number;
  container: AudioContainer;
  /** True when the magic bytes match a container we can actually decode. */
  headerValid: boolean;
  /** Hard stops — the job must not fire. */
  blocking: string[];
  /** Things worth knowing that still allow the render. */
  warnings: string[];
  waveform: WaveformProfile | null;
  checkedAt: string;
};

/** Hard ceiling shared with the timing analyser. */
const MAX_BYTES = 60 * 1024 * 1024;
const MIN_SECONDS = 3;
const MAX_SECONDS = 60 * 12;
const SILENCE_FLOOR = 0.002;

function sniffContainer(head: Uint8Array): AudioContainer {
  const ascii = (start: number, length: number) =>
    String.fromCharCode(...head.subarray(start, start + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(4, 4) === "ftyp") return "mp4";
  if (ascii(0, 3) === "ID3") return "mp3";
  // Bare MPEG audio frame sync (0xFFEx / 0xFFFx).
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return "unknown";
}

function audioContext(): AudioContext {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error("This browser can't decode audio locally.");
  return new Ctor();
}

function profileBuffer(buffer: AudioBuffer): WaveformProfile {
  const channel = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const length = channel.length;

  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  let firstAudible = -1;
  let lastAudible = -1;

  for (let i = 0; i < length; i++) {
    const value = Math.abs(channel[i] ?? 0);
    if (value > peak) peak = value;
    sumSquares += value * value;
    if (value >= 0.999) clipped += 1;
    if (value > SILENCE_FLOOR) {
      if (firstAudible < 0) firstAudible = i;
      lastAudible = i;
    }
  }

  const bucketCount = 120;
  const bucketSize = Math.max(1, Math.floor(length / bucketCount));
  const peaks: number[] = [];
  for (let b = 0; b < bucketCount; b++) {
    let local = 0;
    const start = b * bucketSize;
    for (let i = start; i < Math.min(start + bucketSize, length); i++) {
      const value = Math.abs(channel[i] ?? 0);
      if (value > local) local = value;
    }
    peaks.push(Number(local.toFixed(3)));
  }

  return {
    durationSeconds: buffer.duration,
    sampleRate: rate,
    channels: buffer.numberOfChannels,
    peak: Number(peak.toFixed(4)),
    rms: Number(Math.sqrt(sumSquares / Math.max(1, length)).toFixed(4)),
    leadingSilenceSeconds: firstAudible < 0 ? buffer.duration : firstAudible / rate,
    trailingSilenceSeconds: lastAudible < 0 ? buffer.duration : (length - lastAudible) / rate,
    clippedRatio: Number((clipped / Math.max(1, length)).toFixed(5)),
    peaks,
  };
}

/**
 * Validates the master track. Never throws for a bad file — the caller reads
 * `ok`, `blocking` and `warnings` and decides whether to fire the job.
 */
export async function preflightAudio(file: File | Blob): Promise<AudioPreflightReport> {
  const fileName = (file as File).name || "master track";
  const report: AudioPreflightReport = {
    ok: false,
    fileName,
    bytes: file.size,
    container: "unknown",
    headerValid: false,
    blocking: [],
    warnings: [],
    waveform: null,
    checkedAt: new Date().toISOString(),
  };

  if (file.size === 0) {
    report.blocking.push("That file is empty — nothing was read from disk.");
    return report;
  }
  if (file.size > MAX_BYTES) {
    report.blocking.push("That track is over 60MB — bounce a smaller master and retry.");
    return report;
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  report.container = sniffContainer(head);
  report.headerValid = report.container !== "unknown";
  if (!report.headerValid) {
    report.blocking.push(
      "This file's header isn't a WAV, MP3, M4A, FLAC or OGG stream — it may be renamed or corrupt.",
    );
    return report;
  }

  let ctx: AudioContext | null = null;
  try {
    ctx = audioContext();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    report.waveform = profileBuffer(buffer);
  } catch {
    report.blocking.push("The audio stream couldn't be decoded — the file looks truncated.");
    return report;
  } finally {
    void ctx?.close().catch(() => undefined);
  }

  const wave = report.waveform;
  if (!wave) return report;

  if (wave.durationSeconds < MIN_SECONDS) {
    report.blocking.push(`That track is only ${wave.durationSeconds.toFixed(1)}s long.`);
  }
  if (wave.durationSeconds > MAX_SECONDS) {
    report.blocking.push("That track is over 12 minutes — trim it before rendering.");
  }
  if (wave.peak < SILENCE_FLOOR) {
    report.blocking.push("This track is silent end to end — check the bounce.");
  }

  if (wave.sampleRate < 32000) {
    report.warnings.push(
      `Sample rate is ${wave.sampleRate} Hz — 44.1 kHz or higher keeps the mux clean.`,
    );
  }
  if (wave.channels > 2) {
    report.warnings.push(`${wave.channels} channels detected — only the stereo pair is muxed.`);
  }
  if (wave.leadingSilenceSeconds > 1.5) {
    report.warnings.push(
      `${wave.leadingSilenceSeconds.toFixed(1)}s of silence at the head — the picture starts at 0:00, so cuts will land late.`,
    );
  }
  if (wave.clippedRatio > 0.001) {
    report.warnings.push("The master is clipping — transient detection may misplace cut points.");
  }
  if (wave.rms < 0.02 && wave.peak >= SILENCE_FLOOR) {
    report.warnings.push("Very low level master — beat detection is less reliable.");
  }

  report.ok = report.blocking.length === 0;
  return report;
}

/** One-line summary for toasts and logs. */
export function summarisePreflight(report: AudioPreflightReport): string {
  if (!report.ok) return report.blocking[0] ?? "The master track failed pre-flight.";
  const wave = report.waveform;
  if (!wave) return "Master track verified.";
  return `${report.container.toUpperCase()} · ${wave.durationSeconds.toFixed(1)}s · ${wave.sampleRate} Hz · ${wave.channels === 1 ? "mono" : "stereo"} · peak ${(wave.peak * 100).toFixed(0)}%`;
}
