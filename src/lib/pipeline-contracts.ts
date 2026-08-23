/**
 * Handoff contracts for the studio generate pipeline.
 *
 * Each stage accepts only a typed input and may emit only a typed output.
 * Broken payloads are dropped at the boundary — they never travel downstream.
 * Artist-facing errors stay vendor-neutral; these names are for the server log.
 */

export const PIPELINE_STAGES = {
  lyrics: { id: "lyrics", number: 1, label: "Stage 1" },
  music: { id: "music", number: 2, label: "Stage 2" },
  stems: { id: "stems", number: 3, label: "Stage 3" },
  vocals: { id: "vocals", number: 4, label: "Stage 4" },
  mastering: { id: "mastering", number: 5, label: "Stage 5" },
} as const;

export type PipelineStageId = keyof typeof PIPELINE_STAGES;

export type SonicHandoffPayload = {
  custom_mode: true;
  mv: string;
  title: string;
  tags: string;
  prompt: string;
};

/** Stage 1 — prompt in, cleaned lyric sheet out. */
export type LyricsStageContract = {
  input: { prompt: string };
  output: { lyrics: string };
};

/** Stage 2 — Sonic create payload in, reachable mix + duration out. */
export type BaseAudioContract = {
  input: { payload: SonicHandoffPayload };
  output: { audioUrl: string; duration: number };
};

/** Stage 3 — mix URL in, Demucs vocal + backing stems out. */
export type StemSeparationContract = {
  input: { audioUrl: string };
  output: { vocalStemUrl: string; instrumentalStemUrl: string };
};

/** Stage 4 — target lyrics + voice id in, synthesized vocal URL out. */
export type VocalSynthesisContract = {
  input: { lyrics: string; voiceId: string };
  output: { synthVocalUrl: string };
};

/** Stage 5 — mixed PCM/buffer in, mastered URL out. */
export type MasteringContract = {
  input: { mixedAudio: Uint8Array };
  output: { masteredAudioUrl: string };
};

export const PIPELINE_BREAKER_MESSAGE =
  "Service temporarily experiencing delays, please try again shortly";

export const FAIL_EARLY_GUARD = "FAIL_EARLY_GUARD";

export class FailEarlyGuardError extends Error {
  readonly stage: PipelineStageId;
  readonly stageNumber: number;

  constructor(stage: PipelineStageId, detail: string) {
    const meta = PIPELINE_STAGES[stage];
    super(`${FAIL_EARLY_GUARD}: ${meta.label}: ${detail}`);
    this.name = "FailEarlyGuardError";
    this.stage = stage;
    this.stageNumber = meta.number;
  }
}

export class PipelineBreakerOpenError extends Error {
  readonly stage: PipelineStageId;

  constructor(stage: PipelineStageId) {
    super(PIPELINE_BREAKER_MESSAGE);
    this.name = "PipelineBreakerOpenError";
    this.stage = stage;
  }
}

export function isFailEarlyGuardError(error: unknown): error is FailEarlyGuardError {
  if (error instanceof FailEarlyGuardError) return true;
  return error instanceof Error && error.message.startsWith(`${FAIL_EARLY_GUARD}:`);
}

export function isPipelineBreakerOpenError(error: unknown): boolean {
  if (error instanceof PipelineBreakerOpenError) return true;
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.includes(PIPELINE_BREAKER_MESSAGE);
}

export function isHttpAudioUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when a cloud worker (Replicate, etc.) can fetch the URL over the public
 * internet. Rejects localhost, loopback, link-local, and RFC1918 private hosts.
 */
export function isPublicHttpAudioUrl(value: unknown): value is string {
  if (!isHttpAudioUrl(value)) return false;
  try {
    const { hostname } = new URL(value.trim());
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "0:0:0:0:0:0:0:1" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local")
    ) {
      return false;
    }
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Prefer the first publicly fetchable http(s) URL. Never returns localhost/private URLs. */
export function preferPublicAudioUrl(...candidates: Array<string | null | undefined>): string | null {
  const urls = candidates.filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return urls.find((url) => isPublicHttpAudioUrl(url)) ?? null;
}

export function cleanLyricSheet(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/^```(?:\w+)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();
}

export function logPreConditionPassed(stage: PipelineStageId, detail: string): void {
  console.log(`[PRE-CONDITION PASSED] ${PIPELINE_STAGES[stage].label}: ${detail}`);
}

export function logPostConditionPassed(detail: string): void {
  console.log(`[POST-CONDITION PASSED] ${detail}`);
}

export function logGateCleared(gate: number, detail: string): void {
  console.log(`[GATE ${gate} CLEARED] ${detail}`);
}

export function logFailEarlyGuard(stage: PipelineStageId, detail: string): void {
  console.error(`[FAIL_EARLY_GUARD] ${PIPELINE_STAGES[stage].label}: ${detail}`);
}

export function throwFailEarly(stage: PipelineStageId, detail: string): never {
  logFailEarlyGuard(stage, detail);
  throw new FailEarlyGuardError(stage, detail);
}

export function assertLyricsContractInput(input: LyricsStageContract["input"]): string {
  const prompt = input.prompt.trim();
  if (!prompt) throwFailEarly("lyrics", "prompt was empty");
  return prompt;
}

export function assertLyricsContractOutput(raw: string | null | undefined): LyricsStageContract["output"] {
  const lyrics = cleanLyricSheet(raw);
  if (!lyrics) throwFailEarly("lyrics", "cleaned lyrics were empty");
  return { lyrics };
}

export function assertBaseAudioContractInput(payload: SonicHandoffPayload): SonicHandoffPayload {
  if (!payload.custom_mode) throwFailEarly("music", "Sonic payload missing custom_mode");
  if (!payload.mv?.trim()) throwFailEarly("music", "Sonic payload missing mv");
  if (!payload.title?.trim()) throwFailEarly("music", "Sonic payload missing title");
  return payload;
}

export function assertBaseAudioContractOutput(input: {
  audioUrl: string | null | undefined;
  duration?: number | null;
}): BaseAudioContract["output"] {
  if (!isHttpAudioUrl(input.audioUrl)) {
    throwFailEarly("music", "verified audioUrl was not returned");
  }
  const duration = typeof input.duration === "number" && Number.isFinite(input.duration) && input.duration > 0
    ? input.duration
    : 0;
  return { audioUrl: input.audioUrl.trim(), duration };
}

export function assertStemContractOutput(input: {
  vocalStemUrl?: string | null;
  instrumentalStemUrl?: string | null;
}): StemSeparationContract["output"] {
  if (!isHttpAudioUrl(input.vocalStemUrl) || !isHttpAudioUrl(input.instrumentalStemUrl)) {
    throwFailEarly("stems", "vocal or instrumental stem URL was missing");
  }
  return {
    vocalStemUrl: input.vocalStemUrl.trim(),
    instrumentalStemUrl: input.instrumentalStemUrl.trim(),
  };
}

export function assertVocalContractInput(input: {
  lyrics: string;
  voiceId?: string;
}): VocalSynthesisContract["input"] {
  if (!input.lyrics.trim()) throwFailEarly("vocals", "target lyrics were empty");
  return { lyrics: input.lyrics.trim(), voiceId: input.voiceId?.trim() || "default" };
}

export function assertVocalContractOutput(url: string | null | undefined): VocalSynthesisContract["output"] {
  if (!isHttpAudioUrl(url)) throwFailEarly("vocals", "synth vocal URL was not returned");
  return { synthVocalUrl: url.trim() };
}

export function assertMasteringContractInput(buffer: Uint8Array | null | undefined): Uint8Array {
  if (!buffer || buffer.byteLength < 1024) {
    throwFailEarly("mastering", "mixed audio buffer was empty");
  }
  return buffer;
}

export function assertMasteringContractOutput(url: string | null | undefined): MasteringContract["output"] {
  if (!isHttpAudioUrl(url)) throwFailEarly("mastering", "mastered audio URL was not returned");
  return { masteredAudioUrl: url.trim() };
}
