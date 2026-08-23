/**
 * ElevenLabs Dubbing on Replicate (server only).
 *
 * NOT part of the standard generate or mastering pipeline. Dubbing bills per
 * second of audio, which is far more expensive than the rest of the chain, so
 * nothing in `runHybridMasterPipeline` calls it and no request field can reach
 * it. Multilingual output is handled instead by native bilingual lyrics in
 * Gate 1 and Fish Audio cloning in Gate 4 with `normalize: false`.
 *
 * Kept for a future opt-in localization flow. Any caller must gate it behind an
 * explicit, costed user action — never the default render path.
 *
 * Model input (verified against the published schema):
 *   - `audio_or_video_file` or `source_url` — one is required
 *   - `target_language`  BCP-47, required
 *   - `source_language`  BCP-47 or "auto"
 *   - `cloning_strength` integer 0–10, default 7
 */

import { replicateBaseUrl } from "@/lib/ai-provider.server";
import { requireStageKey } from "@/lib/env";
import {
  REPLICATE_PREDICTION_TIMEOUT_MS,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";
import { resilientFetch } from "@/lib/resilient-fetch.server";
import { isHttpAudioUrl } from "@/lib/pipeline-contracts";

const DUBBING_MODEL = process.env["DUBBING_MODEL"]?.trim() || "elevenlabs/dubbing";

/** Schema default. Higher keeps the source voice, lower frees up delivery. */
export const DEFAULT_CLONING_STRENGTH = 7;
export const MIN_CLONING_STRENGTH = 0;
export const MAX_CLONING_STRENGTH = 10;

/**
 * Target languages the model accepts, as BCP-47 tags. Sent verbatim: an
 * unlisted tag is rejected by the model, so the caller resolves first.
 */
export const DUBBING_TARGET_LANGUAGES = [
  "af","ak","sq","am","ar","ar-EG","hy","as","az","eu","be","bs","bg","my","yue","ca","ceb","zh",
  "zh-TW","hr","cs","da","dgo","nl","en","en-AU","en-CA","en-GB","en-US","et","fil","fi","fr",
  "fr-CA","fr-FR","gl","ka","de","el","gu","ha","he","hi","hu","is","id","it","ja","jv","kn","kk",
  "ki","rw","rn","ko","ky","lv","lt","lg","mk","ms","ml","cmn","mr","mn","ne","no","fa","pl","pt",
  "pt-BR","pt-PT","pa","ro","ru","nso","st","sd","sk","sl","es","es-AR","es-CL","es-ES","es-MX",
  "su","sw","ss","sv","tg","ta","te","th","bo","ts","tn","tr","uk","ur","ug","uz","ve","vi","war",
  "cy","wo","yo","zu",
] as const;

export type DubbingTargetLanguage = (typeof DUBBING_TARGET_LANGUAGES)[number];

const TARGETS = new Set<string>(DUBBING_TARGET_LANGUAGES);

/** Maps a studio language choice onto a tag the model accepts. */
export function resolveDubbingLanguage(value: string | undefined): DubbingTargetLanguage | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (TARGETS.has(raw)) return raw as DubbingTargetLanguage;
  const lower = raw.toLowerCase();
  for (const tag of DUBBING_TARGET_LANGUAGES) {
    if (tag.toLowerCase() === lower) return tag;
  }
  // "pt-br" style input, or a bare base language for a region-only match.
  const base = lower.split(/[-_]/)[0] ?? "";
  for (const tag of DUBBING_TARGET_LANGUAGES) {
    if (tag.toLowerCase() === base) return tag;
  }
  return null;
}

export function clampCloningStrength(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CLONING_STRENGTH;
  return Math.min(MAX_CLONING_STRENGTH, Math.max(MIN_CLONING_STRENGTH, Math.round(value)));
}

type PredictionState = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
};

function credentials(): Record<string, string> {
  const token =
    process.env.REPLICATE_API_KEY?.trim() ||
    requireStageKey("REPLICATE_API_KEY", "Dubbing");
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

function isTerminalFailure(status: string | undefined): boolean {
  return status === "failed" || status === "canceled" || status === "aborted";
}

/** Pulls the dubbed audio URL out of whichever shape the model returns. */
export function parseDubbingOutput(output: unknown): string | null {
  if (typeof output === "string") return isHttpAudioUrl(output) ? output : null;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = parseDubbingOutput(item);
      if (url) return url;
    }
    return null;
  }
  if (output && typeof output === "object") {
    const row = output as Record<string, unknown>;
    return parseDubbingOutput(row.audio ?? row.audio_url ?? row.output ?? row.url ?? row.dubbed);
  }
  return null;
}

export type DubbingRequest = {
  /** Public URL of the vocal (or full mix) to localize. */
  sourceUrl: string;
  targetLanguage: string;
  sourceLanguage?: string;
  cloningStrength?: number;
};

/**
 * Runs one dubbing pass and returns the localized audio URL.
 *
 * Dispatch asks for only a brief sync wait and then polls, because holding the
 * create request open lets a dropped connection register as a client
 * disconnect, which Replicate records as an aborted prediction.
 */
export async function dubVocalTrack(input: DubbingRequest): Promise<string> {
  if (!isHttpAudioUrl(input.sourceUrl)) {
    throw new Error("Dubbing needs a public audio URL for the source vocal.");
  }
  const target = resolveDubbingLanguage(input.targetLanguage);
  if (!target) {
    throw new Error(`Dubbing does not support the language "${input.targetLanguage}".`);
  }
  const source = resolveDubbingLanguage(input.sourceLanguage) ?? "auto";
  const cloningStrength = clampCloningStrength(input.cloningStrength);

  const body = {
    input: {
      source_url: input.sourceUrl,
      target_language: target,
      source_language: source,
      cloning_strength: cloningStrength,
    },
  };
  console.warn("[GATE_4_DUBBING_DISPATCH]", {
    model: DUBBING_MODEL,
    target_language: target,
    source_language: source,
    cloning_strength: cloningStrength,
  });

  const created = await resilientFetch(
    `${replicateBaseUrl()}/models/${DUBBING_MODEL}/predictions`,
    {
      method: "POST",
      headers: { ...credentials(), ...replicateRunHeaders(REPLICATE_PREDICTION_TIMEOUT_MS) },
      body: JSON.stringify(body),
    },
    { label: "dubbing dispatch", breakerKey: "vocals:dubbing", timeoutMs: 90_000, retries: 0 },
  );
  if (!created.ok) {
    const detail = await created.text().catch(() => "");
    console.error("[GATE_4_DUBBING_ERROR]", created.status, detail.slice(0, 400));
    throw new Error(`Dubbing dispatch failed [${created.status}].`);
  }

  let prediction = (await created.json()) as PredictionState;
  const id = prediction.id;
  if (!id) throw new Error("The dubbing worker returned no job id.");

  const deadline = Date.now() + REPLICATE_PREDICTION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (prediction.status === "succeeded") {
      const url = parseDubbingOutput(prediction.output);
      if (!url) throw new Error("Dubbing finished without returning audio.");
      console.warn("[GATE_4_DUBBING_READY]", { target_language: target, url });
      return url;
    }
    if (isTerminalFailure(prediction.status)) {
      throw new Error(String(prediction.error ?? "Dubbing failed for this track."));
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const poll = await resilientFetch(
      `${replicateBaseUrl()}/predictions/${id}`,
      { headers: credentials() },
      { label: "dubbing poll", timeoutMs: 20_000, retries: 0, baseDelayMs: 1000 },
    );
    if (!poll.ok) {
      const detail = await poll.text().catch(() => "");
      console.error("[GATE_4_DUBBING_ERROR]", poll.status, detail.slice(0, 400));
      throw new Error(`Dubbing poll failed [${poll.status}].`);
    }
    prediction = (await poll.json()) as PredictionState;
  }

  throw new Error("Dubbing timed out for this track.");
}
