import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import { LOUDNORM_FILTER } from "@/lib/loudnorm";
import { masteredTrackObjectPath } from "@/lib/audio-vault";

/** Hard cap so a stuck Python/FFmpeg child never hangs a generation. */
export const MATCHERING_PIPELINE_TIMEOUT_MS = 90_000;
/** Matchering 2.0 itself: after 30s abort and finish with FFmpeg loudnorm. */
export const MATCHERING_PROCESS_TIMEOUT_MS = 30_000;
export const MATCHERING_MIX_TIMEOUT_MS = 60_000;

export const MATCHERING_REFERENCE_RELATIVE = "public/references/master_reference.wav";
export const MATCHERING_SCRIPT_RELATIVE = "scripts/matchering_master.py";

/** Brickwall ceiling (~ -1 dBTP) before streaming loudnorm. */
export const BRICKWALL_LIMITER = "alimiter=limit=0.891250938:level=false";
export const MATCHERING_FINISH_FILTER = `${BRICKWALL_LIMITER},${LOUDNORM_FILTER}`;

/**
 * Gate 3 instrumental + Fish vocal remux — exact production filter:
 * amix duration=first, dropout_transition=0, normalize=0 (no auto ducking),
 * then loudnorm in the same chain.
 */
export const HYBRID_REMUX_AMIX =
  "amix=inputs=2:duration=first:dropout_transition=0:normalize=0";
export const HYBRID_REMUX_LOUDNORM = "loudnorm=I=-14:LRA=11:TP=-1.5";
export const HYBRID_REMUX_MIX_FILTER = `${HYBRID_REMUX_AMIX},${HYBRID_REMUX_LOUDNORM}`;

export type HybridStemKind = "intro" | "instrumental" | "vocal";

export type HybridStemInputs = {
  introPath?: string;
  instrumentalPath?: string;
  vocalPath?: string;
};

export type HybridStemSlot = { kind: HybridStemKind; path: string };

export function collectHybridStems(stems: HybridStemInputs): HybridStemSlot[] {
  const slots: HybridStemSlot[] = [];
  if (stems.introPath) slots.push({ kind: "intro", path: stems.introPath });
  if (stems.instrumentalPath) slots.push({ kind: "instrumental", path: stems.instrumentalPath });
  if (stems.vocalPath) slots.push({ kind: "vocal", path: stems.vocalPath });
  return slots;
}

function stereo(label: string, extra = ""): string {
  const rest = extra ? `,${extra}` : "";
  return `[${label}]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo${rest},asetpts=PTS-STARTPTS`;
}

function volumeGain(value: number): string {
  // Keep a decimal so FFmpeg graphs stay readable as volume=1.0 (not volume=1).
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}


/**
 * Mix graph: optional intro, then Gate 3 Demucs instrumental under Fish vocals.
 *
 * Production remux (instrumental + vocal):
 *   [0:a]volume=1.0[inst];[1:a]volume=1.0[vox];
 *   [inst][vox]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14:LRA=11:TP=-1.5
 *
 * Volumes may be nudged by CWALO Gate 2 remux hints (bed never below 1.0).
 */
export function buildHybridMixFilterComplex(
  slots: HybridStemSlot[],
  introSeconds: number = HYBRID_INTRO_SECONDS,
  gains: { instrumentalVolume?: number; vocalVolume?: number } = {},
): string {
  if (slots.length === 0) throw new Error("No stems to mix.");
  if (slots.length === 1) return `${stereo("0:a")}[out]`;

  const instVol = Math.max(1.0, gains.instrumentalVolume ?? 1.0);
  const vocVol = gains.vocalVolume ?? 1.0;

  const indexOf = (kind: HybridStemKind) => slots.findIndex((slot) => slot.kind === kind);
  const intro = indexOf("intro");
  const inst = indexOf("instrumental");
  const vocal = indexOf("vocal");

  const lines: string[] = [];
  if (intro >= 0) {
    lines.push(`${stereo(`${intro}:a`, `atrim=0:${introSeconds}`)}[intro]`);
  }
  if (inst >= 0) lines.push(`${stereo(`${inst}:a`, `volume=${volumeGain(instVol)}`)}[inst]`);
  if (vocal >= 0) lines.push(`${stereo(`${vocal}:a`, `volume=${volumeGain(vocVol)}`)}[vox]`);

  let core = "";
  if (inst >= 0 && vocal >= 0) {
    lines.push(`[inst][vox]${HYBRID_REMUX_MIX_FILTER}[core]`);
    core = "[core]";
  } else if (inst >= 0) {
    core = "[inst]";
  } else if (vocal >= 0) {
    core = "[vox]";
  }

  if (intro >= 0 && core) {
    lines.push(`[intro]${core}concat=n=2:v=0:a=1[out]`);
  } else if (intro >= 0) {
    lines.push("[intro]anull[out]");
  } else {
    lines.push(`${core}anull[out]`);
  }
  return lines.join(";");
}

/** True when the mix graph already applied the remux loudnorm chain. */
export function hybridMixIncludesLoudnorm(stems: HybridStemInputs): boolean {
  return Boolean(stems.instrumentalPath && stems.vocalPath);
}

export function buildHybridMixArgs(
  stems: HybridStemInputs,
  outputWav: string,
  gains?: { instrumentalVolume?: number; vocalVolume?: number },
): string[] {
  const slots = collectHybridStems(stems);
  if (slots.length === 0) throw new Error("No stems to mix.");
  const inputs = slots.flatMap((slot) => ["-i", slot.path]);
  if (slots.length === 1) {
    return [
      "-y",
      "-hide_banner",
      "-nostdin",
      ...inputs,
      "-ac",
      "2",
      "-ar",
      "44100",
      "-c:a",
      "pcm_s24le",
      outputWav,
    ];
  }
  return [
    "-y",
    "-hide_banner",
    "-nostdin",
    ...inputs,
    "-filter_complex",
    buildHybridMixFilterComplex(slots, HYBRID_INTRO_SECONDS, gains),
    "-map",
    "[out]",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-c:a",
    "pcm_s24le",
    outputWav,
  ];
}

export function matcheringPythonArgs(input: {
  scriptPath: string;
  target: string;
  reference: string;
  outWav: string;
  timeoutSeconds?: number;
}): string[] {
  const timeoutSeconds = Math.max(
    1,
    Math.round((input.timeoutSeconds ?? MATCHERING_PROCESS_TIMEOUT_MS / 1000) * 10) / 10,
  );
  return [
    input.scriptPath,
    "--target",
    input.target,
    "--reference",
    input.reference,
    "--out-wav",
    input.outWav,
    "--timeout",
    String(timeoutSeconds),
  ];
}

/** Fade length at the track tail so cuts / trailing glitches never click. */
export const MASTER_FADE_OUT_SECONDS = 4;

/**
 * Final encode. When a ceiling is given the master is hard-limited to it with a
 * fade running into the cut, so a request for three minutes cannot come back
 * longer than three minutes.
 *
 * When only a known duration is available (no hard ceiling), still apply a clean
 * 4s exponential fade-out at `duration - 4` to kill trailing noise bursts.
 *
 * When `skipLoudnorm` is set (remux already baked loudnorm into the mix WAV),
 * only the brickwall limiter + fade run so we do not double-norm.
 */
export function matcheringFinishArgs(
  inputWav: string,
  outputMp3: string,
  maxSeconds?: number,
  options: { skipLoudnorm?: boolean; durationSeconds?: number } = {},
): string[] {
  const ceiling =
    typeof maxSeconds === "number" && Number.isFinite(maxSeconds) && maxSeconds > MASTER_FADE_OUT_SECONDS
      ? Math.round(maxSeconds)
      : undefined;
  const knownDuration =
    ceiling ??
    (typeof options.durationSeconds === "number" &&
    Number.isFinite(options.durationSeconds) &&
    options.durationSeconds > MASTER_FADE_OUT_SECONDS
      ? options.durationSeconds
      : undefined);
  const fadeStart =
    knownDuration !== undefined ? knownDuration - MASTER_FADE_OUT_SECONDS : undefined;
  const baseFilter = options.skipLoudnorm ? BRICKWALL_LIMITER : MATCHERING_FINISH_FILTER;
  const filter =
    fadeStart === undefined
      ? baseFilter
      : `${baseFilter},afade=t=out:st=${fadeStart}:d=${MASTER_FADE_OUT_SECONDS}:curve=exp`;

  return [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputWav,
    ...(ceiling ? ["-t", String(ceiling)] : []),
    "-af",
    filter,
    "-b:a",
    "320k",
    outputMp3,
  ];
}

export function masteredPlayablePath(userId: string, taskId: string): string {
  return masteredTrackObjectPath(userId, taskId, "mp3");
}

export function masteredPcmPath(userId: string, taskId: string): string {
  return masteredTrackObjectPath(userId, taskId, "wav");
}
