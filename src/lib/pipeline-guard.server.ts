import { hasPaidAiKey, hasReplicateKey } from "@/lib/ai-provider.server";
/**
 * Pre-flight validation shield for the cinematic pipeline (server only).
 *
 * Runs BEFORE any paid call is dispatched (foundation frame, motion block,
 * enhancement) so malformed or unauthenticated jobs are rejected locally
 * instead of burning provider credits on a guaranteed 400 / 401 / 404.
 *
 * The fallback cascade and circuit breaker for 429 / 503 / 402 live in
 * `visual-engines.server.ts` — this module only guards the entry point.
 */

export type GenerationTask = {
  shotId: string;
  prompt: string;
  /** Motion class the router will dispatch against. */
  shotClass?: "performance" | "action" | "environment" | undefined;
  referenceImage?: string | undefined;
  audioReference?: string | undefined;
};

export type PreflightResult = { isValid: true } | { isValid: false; code: number; message: string };

/** Minimum prompt the engines can act on — anything shorter renders noise. */
const MIN_PROMPT_CHARS = 8;

export function validatePayload(task: GenerationTask): PreflightResult {
  if (!task.shotId?.trim()) {
    return { isValid: false, code: 400, message: "Bad request: this shot has no id." };
  }
  const prompt = task.prompt?.trim() ?? "";
  if (prompt.length < MIN_PROMPT_CHARS) {
    return { isValid: false, code: 400, message: "Bad request: this shot has no usable text prompt." };
  }
  if (task.shotClass && !["performance", "action", "environment"].includes(task.shotClass)) {
    return { isValid: false, code: 404, message: "Not found: unknown motion class for this shot." };
  }
  // References stay deliberately flexible: remote URLs, inline data URIs,
  // browser blob handles and same-origin paths are all legitimate sources for
  // a shot's picture or audio. Only obviously unusable values are rejected.
  const REFERENCE_SOURCE = /^(https?:|data:|blob:|file:|\/)/i;
  for (const [label, value] of [
    ["reference image", task.referenceImage],
    ["audio reference", task.audioReference],
  ] as const) {
    const source = value?.trim();
    if (source && !REFERENCE_SOURCE.test(source)) {
      return { isValid: false, code: 400, message: `Bad request: the ${label} for this shot is not a valid source.` };
    }
  }
  // Paid render path: the paid Google credential and the Replicate token must
  // both be present. The free Hybrid key is never accepted here.
  if (!hasPaidAiKey() || !hasReplicateKey()) {
    return {
      isValid: false,
      code: 401,
      message: "Unauthorized: the paid render engines are not configured yet.",
    };
  }
  return { isValid: true };
}

export class PreflightError extends Error {
  status: number;
  detail = "";
  constructor(code: number, message: string) {
    super(message);
    this.name = "PreflightError";
    this.status = code;
  }
}

/** Throws a typed error when the task can never succeed upstream. */
export function assertRenderable(task: GenerationTask): void {
  const check = validatePayload(task);
  if (!check.isValid) throw new PreflightError(check.code, check.message);
}
