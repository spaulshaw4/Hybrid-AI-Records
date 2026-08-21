/** Streaming / broadcast loudness targets (EBU R128-style). */
export const STREAMING_LUFS = -14;
export const TRUE_PEAK_DBTP = -1.5;
export const LOUDNESS_RANGE = 11;
export const MASTER_AUDIO_BITRATE = "320k";

export const LOUDNORM_FILTER = `loudnorm=I=${STREAMING_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE}`;

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
    `TP=${TRUE_PEAK_DBTP}`,
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

export function measureLoudnormArgs(inputAudioPath: string): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-i",
    inputAudioPath,
    "-af",
    `${LOUDNORM_FILTER}:print_format=json`,
    "-f",
    "null",
    "-",
  ];
}

/** Matches: ffmpeg -i in -af loudnorm=I=-14:TP=-1.5:LRA=11 -b:a 320k out */
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
