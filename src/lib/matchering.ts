import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import { LOUDNORM_FILTER } from "@/lib/loudnorm";
import { masteredTrackObjectPath } from "@/lib/audio-vault";

/** Hard cap so a stuck Python/FFmpeg child never hangs a generation. */
export const MATCHERING_PIPELINE_TIMEOUT_MS = 180_000;
export const MATCHERING_PROCESS_TIMEOUT_MS = 120_000;
export const MATCHERING_MIX_TIMEOUT_MS = 90_000;

export const MATCHERING_REFERENCE_RELATIVE = "public/references/master_reference.wav";
export const MATCHERING_SCRIPT_RELATIVE = "scripts/matchering_master.py";

/** Brickwall ceiling (~ -1 dBTP) before streaming loudnorm. */
export const BRICKWALL_LIMITER = "alimiter=limit=0.891250938:level=false";
export const MATCHERING_FINISH_FILTER = `${BRICKWALL_LIMITER},${LOUDNORM_FILTER}`;

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

/**
 * Mix graph: 30s ElevenLabs intro, then MiniMax instrumental under Fish/ACE vocals.
 * Missing stems are skipped so a partial render still produces a file.
 */
export function buildHybridMixFilterComplex(
  slots: HybridStemSlot[],
  introSeconds: number = HYBRID_INTRO_SECONDS,
): string {
  if (slots.length === 0) throw new Error("No stems to mix.");
  if (slots.length === 1) return `${stereo("0:a")}[out]`;

  const indexOf = (kind: HybridStemKind) => slots.findIndex((slot) => slot.kind === kind);
  const intro = indexOf("intro");
  const inst = indexOf("instrumental");
  const vocal = indexOf("vocal");

  const lines: string[] = [];
  if (intro >= 0) {
    lines.push(`${stereo(`${intro}:a`, `atrim=0:${introSeconds}`)}[intro]`);
  }
  if (inst >= 0) lines.push(`${stereo(`${inst}:a`)}[inst]`);
  if (vocal >= 0) lines.push(`${stereo(`${vocal}:a`)}[voc]`);

  let core = "";
  if (inst >= 0 && vocal >= 0) {
    lines.push("[inst][voc]amix=inputs=2:duration=longest:dropout_transition=2:normalize=0[core]");
    core = "[core]";
  } else if (inst >= 0) {
    core = "[inst]";
  } else if (vocal >= 0) {
    core = "[voc]";
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

export function buildHybridMixArgs(stems: HybridStemInputs, outputWav: string): string[] {
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
    buildHybridMixFilterComplex(slots),
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
}): string[] {
  return [
    input.scriptPath,
    "--target",
    input.target,
    "--reference",
    input.reference,
    "--out-wav",
    input.outWav,
  ];
}

export function matcheringFinishArgs(inputWav: string, outputMp3: string): string[] {
  return [
    "-y",
    "-hide_banner",
    "-nostdin",
    "-i",
    inputWav,
    "-af",
    MATCHERING_FINISH_FILTER,
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
