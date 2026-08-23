/**
 * Fail-early gates for the studio generate pipeline.
 *
 * Message format is `GATE_N_FAILED: …` so the server log, the server-function
 * boundary, and the studio UI all name the same step. Artist-facing copy is
 * mapped in `explainEngineFailure` — do not put vendor names here.
 */

import { isFailEarlyGuardError, isPipelineBreakerOpenError } from "@/lib/pipeline-contracts";

export const STUDIO_PIPELINE_GATES = ["GATE_1", "GATE_2", "GATE_3", "GATE_4", "GATE_5"] as const;

export type StudioPipelineGate = (typeof STUDIO_PIPELINE_GATES)[number];

export class StudioPipelineError extends Error {
  readonly gate: StudioPipelineGate;
  readonly step: `${StudioPipelineGate}_FAILED`;

  constructor(gate: StudioPipelineGate, detail: string) {
    super(`${gate}_FAILED: ${detail}`);
    this.name = "StudioPipelineError";
    this.gate = gate;
    this.step = `${gate}_FAILED`;
  }
}

const GATE_FAILED_RE = /^GATE_([1-5])_FAILED:/;

export function isStudioPipelineError(error: unknown): error is StudioPipelineError {
  if (error instanceof StudioPipelineError) return true;
  return error instanceof Error && GATE_FAILED_RE.test(error.message);
}

export function studioPipelineGateName(error: unknown): StudioPipelineGate | null {
  if (error instanceof StudioPipelineError) return error.gate;
  const text = error instanceof Error ? error.message : String(error ?? "");
  const match = text.match(GATE_FAILED_RE);
  if (!match) return null;
  return `GATE_${match[1]}` as StudioPipelineGate;
}

/** Server / studio console: which gate or guard aborted the run. Never throws. */
export function logFailedStudioGate(error: unknown): void {
  const gate = studioPipelineGateName(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (gate) {
    console.error("[GATE FAILED]", gate, message);
    return;
  }
  if (isFailEarlyGuardError(error) || isPipelineBreakerOpenError(error)) {
    console.error("[GATE FAILED]", message);
  }
}

export function shouldRethrowPipelineControlError(error: unknown): boolean {
  return (
    isStudioPipelineError(error) ||
    isFailEarlyGuardError(error) ||
    isPipelineBreakerOpenError(error)
  );
}
