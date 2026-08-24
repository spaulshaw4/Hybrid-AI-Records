/** Streaming / broadcast loudness targets (EBU R128). */
export const STREAMING_LUFS = -14;
/** True-peak ceiling — Gate 6 mastering standard (-1.0 dBFS / dBTP). */
export const TRUE_PEAK_DBTP = -1.0;
/** Loudness range target (±0.5 LU integrated tolerance via two-pass linear). */
export const LOUDNESS_RANGE = 7;
export const MASTER_AUDIO_BITRATE = "320k";

/** Canonical one-pass / print filter: I=-14, LRA=7, TP=-1.0 */
export const LOUDNORM_FILTER = `loudnorm=I=${STREAMING_LUFS}:LRA=${LOUDNESS_RANGE}:TP=-1.0`;

/**
 * Static one-pass loudnorm fallback when two-pass measurement JSON is unavailable.
 * FFmpeg accepts `TP=` / `tp=` for true peak; Gate 6 prefers measured two-pass.
 */
export const STATIC_EBU_R128_LOUDNORM = "loudnorm=I=-14:LRA=7:TP=-1.0";

/**
 * Deterministic Gate 6 mastering filter — broadcast-ready (-14 LUFS / -1.0 dBFS peak).
 * Applied as `-af <filter>` on the final FFmpeg encode.
 */
export const GATE_6_EBU_R128_MASTERING_FILTER =
  "loudnorm=I=-14:LRA=7:tp=-1.0:measured_I=-14:measured_tp=-1.0:offset=0.0:linear=true:print_format=summary";

/**
 * Local Gate 6 master EQ (FFmpeg only) — light HP + presence / air shelves before loudnorm.
 * Kept gentle so Gate 2 vault audio keeps punch and stereo width.
 */
export const GATE_6_MASTER_EQ =
  "highpass=f=30,equalizer=f=120:width_type=o:width=1:g=1.2,equalizer=f=3500:width_type=o:width=1.2:g=1.5,equalizer=f=12000:width_type=o:width=1:g=1";

/** FFmpeg argv fragment: `['-af', GATE_6_EBU_R128_MASTERING_FILTER]` */
export const ffmpegMasteringFilter = ["-af", GATE_6_EBU_R128_MASTERING_FILTER] as const;

/** Compose master EQ + loudnorm into a single `-af` chain. */
export function gate6MasterAfChain(loudnormPart: string): string {
  return `${GATE_6_MASTER_EQ},${loudnormPart}`;
}

export type LoudnormMeasurement = {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
};

/** One-pass filter (used when measurement JSON is unavailable). */
export function loudnormFilter(): string {
  return LOUDNORM_FILTER;
}

/** Linear second-pass filter so the file actually lands at the measured target. */
export function loudnormTwoPassFilter(measured: LoudnormMeasurement): string {
  return [
    `loudnorm=I=${STREAMING_LUFS}`,
    "TP=-1.0",
    `LRA=${LOUDNESS_RANGE}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    "linear=true",
  ].join(":");
}
export function parseLoudnormMeasurement(stderr: string): LoudnormMeasurement | null {
  const match = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<LoudnormMeasurement>;
    if (
      typeof parsed.input_i !== "string" ||
      typeof parsed.input_tp !== "string" ||
      typeof parsed.input_lra !== "string" ||
      typeof parsed.input_thresh !== "string" ||
      typeof parsed.target_offset !== "string"
    ) {
      return null;
    }
    return {
      input_i: parsed.input_i,
      input_tp: parsed.input_tp,
      input_lra: parsed.input_lra,
      input_thresh: parsed.input_thresh,
      target_offset: parsed.target_offset,
    };
  } catch {
    return null;
  }
}

export function measureLoudnormArgs(
  inputAudioPath: string,
  options: { withMasterEq?: boolean } = {},
): string[] {
  const loudnorm = `${LOUDNORM_FILTER}:print_format=json`;
  const af = options.withMasterEq ? gate6MasterAfChain(loudnorm) : loudnorm;
  return [
    "-hide_banner",
    "-nostdin",
    "-i",
    inputAudioPath,
    "-af",
    af,
    "-f",
    "null",
    "-",
  ];
}

/** Matches: ffmpeg -i in -af loudnorm=I=-14:LRA=7:TP=-1.0 -b:a 320k out */
export function finalizeTrackMasterArgs(
  inputAudioPath: string,
  outputMasterPath: string,
  filter: string = LOUDNORM_FILTER,
): string[] {
  return [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputAudioPath,
    "-af",
    filter,
    "-b:a",
    MASTER_AUDIO_BITRATE,
    outputMasterPath,
  ];
}

/**
 * Gate 6 local master: EQ + two-pass (or one-pass) loudnorm → 320 kbps MP3.
 * `filter` should already include EQ when using the Gate 6 chain.
 */
export function gate6LocalMasterArgs(
  inputAudioPath: string,
  outputMasterPath: string,
  loudnormPart: string,
): string[] {
  return finalizeTrackMasterArgs(
    inputAudioPath,
    outputMasterPath,
    gate6MasterAfChain(loudnormPart),
  );
}
