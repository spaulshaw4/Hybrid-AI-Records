/**
 * Shared studio generate progress map (6-gate architecture).
 * Server stages call `reportPipelineProgress`; the studio bar reads the same percents.
 */

export const PIPELINE_PROGRESS = {
  lyrics: 12,
  sonic: 28,
  vault: 40,
  cwalo: 52,
  stems: 65,
  vocals: 78,
  master: 92,
  complete: 100,
} as const;

export type PipelineProgressStage = keyof typeof PIPELINE_PROGRESS;

export const PIPELINE_PROGRESS_LABELS: Record<PipelineProgressStage, string> = {
  lyrics: "Writing lyrics…",
  sonic: "Building the base track…",
  vault: "Vaulting audio to Supabase…",
  cwalo: "Analyzing structure (CWALO)…",
  stems: "Separating stems…",
  vocals: "Rendering vocals…",
  master: "Mastering the mix…",
  complete: "Master track ready",
};

export type StudioProgressCallback = (
  stage: string,
  percent: number,
  pipelineState?: number,
) => void;

export function normalizeProgressStage(stage: string): PipelineProgressStage | null {
  const key = stage.trim().toLowerCase();
  if (key in PIPELINE_PROGRESS) return key as PipelineProgressStage;
  if (key === "music" || key === "base" || key === "base audio" || key === "composition") {
    return "sonic";
  }
  if (key === "vaulting" || key === "supabase" || key === "gate_2_vaulted" || key === "storage") {
    return "vault";
  }
  if (key === "structure" || key === "analysis" || key === "cwalo structure") return "cwalo";
  if (key === "mastering" || key === "matchering") return "master";
  if (key === "demux") return "stems";
  return null;
}

export function labelForProgressStage(stage: string): string {
  const known = normalizeProgressStage(stage);
  return known ? PIPELINE_PROGRESS_LABELS[known] : stage;
}

export function percentForProgressStage(stage: string): number {
  const known = normalizeProgressStage(stage);
  return known ? PIPELINE_PROGRESS[known] : 0;
}

export function reportPipelineProgress(
  stage: string,
  percent: number,
  onProgress?: StudioProgressCallback,
  pipelineState?: number,
): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (typeof pipelineState === "number") {
    console.log("[PROGRESS]", stage, clamped, `flags=0b${pipelineState.toString(2)}`);
  } else {
    console.log("[PROGRESS]", stage, clamped);
  }
  onProgress?.(stage, clamped, pipelineState);
}
