/**
 * Pre-upload quality checks for voice samples.
 *
 * A clone is only as good as the clip it learns from, so before anything
 * reaches storage we decode the trimmed sample and look for the two failure
 * modes we see most: near-silence (mic muted / too far away) and clipping
 * (input gain way too hot). Severe cases block the upload; borderline cases
 * warn but let the artist continue.
 */

/** Anything at or above this absolute value counts as a clipped sample. */
export const CLIP_THRESHOLD = 0.99;
/** Frames quieter than this count as silence. */
export const SILENCE_FLOOR = 0.005;

/** Hard limits — cloning is blocked. */
const BLOCK_RMS = 0.008; // ~ -42 dBFS average: effectively silence
const BLOCK_SILENCE_RATIO = 0.7; // 70%+ of the clip is dead air
const BLOCK_CLIP_RATIO = 0.02; // 2%+ of frames pinned at full scale

/** Soft limits — warn only. */
const WARN_RMS = 0.02; // quiet but usable
const WARN_SILENCE_RATIO = 0.4;
const WARN_CLIP_RATIO = 0.002;
const WARN_PEAK = 0.15; // barely moves the meter

export type QualityIssue = {
  id: "silence" | "quiet" | "clipping" | "hot";
  level: "block" | "warn";
  message: string;
};

/** Waveform resolution used for the bar-level clipping / silence counts. */
export const BAR_COUNT = 160;

export type SampleQuality = {
  /** Peak absolute amplitude, 0–1. */
  peak: number;
  /** Average loudness, 0–1. */
  rms: number;
  /** Share of frames pinned at full scale, 0–1. */
  clipRatio: number;
  /** Share of frames below the silence floor, 0–1. */
  silenceRatio: number;
  /** Waveform bars (of BAR_COUNT) whose peak hits the clipping ceiling. */
  clipBars: number;
  /** Waveform bars (of BAR_COUNT) whose peak sits below the silence floor. */
  silenceBars: number;
  /** Total bars analysed. */
  totalBars: number;
  issues: QualityIssue[];
  /** True when at least one issue is severe enough to stop the upload. */
  blocked: boolean;
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

/** Decodes the clip and grades it. Returns null when the browser can't decode. */
export async function analyseVoiceSample(file: File): Promise<SampleQuality | null> {
  const AudioCtx =
    typeof window === "undefined"
      ? undefined
      : window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;

  const context = new AudioCtx();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const data = decoded.getChannelData(0);
    if (data.length === 0) return null;

    let peak = 0;
    let sumSquares = 0;
    let clipped = 0;
    let silent = 0;

    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
      sumSquares += v * v;
      if (v >= CLIP_THRESHOLD) clipped += 1;
      if (v < SILENCE_FLOOR) silent += 1;
    }

    // Bar-level counts mirror what the waveform preview draws.
    const totalBars = Math.min(BAR_COUNT, data.length);
    const barSize = Math.max(1, Math.floor(data.length / totalBars));
    let clipBars = 0;
    let silenceBars = 0;
    for (let bar = 0; bar < totalBars; bar += 1) {
      let barPeak = 0;
      const end = Math.min(data.length, (bar + 1) * barSize);
      for (let i = bar * barSize; i < end; i += 1) {
        const v = Math.abs(data[i] ?? 0);
        if (v > barPeak) barPeak = v;
      }
      if (barPeak >= CLIP_THRESHOLD) clipBars += 1;
      if (barPeak < SILENCE_FLOOR) silenceBars += 1;
    }

    const rms = Math.sqrt(sumSquares / data.length);
    const clipRatio = clipped / data.length;
    const silenceRatio = silent / data.length;
    const issues: QualityIssue[] = [];

    if (rms < BLOCK_RMS || silenceRatio > BLOCK_SILENCE_RATIO) {
      issues.push({
        id: "silence",
        level: "block",
        message: `This sample is almost silent (${pct(silenceRatio)} dead air). Check your mic input and record again closer to the mic.`,
      });
    } else if (rms < WARN_RMS || silenceRatio > WARN_SILENCE_RATIO || peak < WARN_PEAK) {
      issues.push({
        id: "quiet",
        level: "warn",
        message: `This sample is quiet (${pct(silenceRatio)} dead air). Cloning works better with a louder, continuous take.`,
      });
    }

    if (clipRatio > BLOCK_CLIP_RATIO) {
      issues.push({
        id: "clipping",
        level: "block",
        message: `Heavy clipping detected (${pct(clipRatio)} of the clip is distorted). Lower your input gain and record again.`,
      });
    } else if (clipRatio > WARN_CLIP_RATIO || peak >= CLIP_THRESHOLD) {
      issues.push({
        id: "hot",
        level: "warn",
        message: "The input is running hot and may distort. Backing the gain off a little will clone cleaner.",
      });
    }

    return {
      peak,
      rms,
      clipRatio,
      silenceRatio,
      clipBars,
      silenceBars,
      totalBars,
      issues,
      blocked: issues.some((issue) => issue.level === "block"),
    };
  } catch {
    return null;
  } finally {
    void context.close();
  }
}

/** Rough dBFS readout for the UI. */
export function toDb(value: number) {
  if (value <= 0) return "-∞ dB";
  return `${(20 * Math.log10(value)).toFixed(1)} dB`;
}
