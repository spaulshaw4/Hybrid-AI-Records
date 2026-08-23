/**
 * Shared studio generate progress map.
 * Server stages call `reportPipelineProgress`; the studio bar reads the same percents.
 */

export const PIPELINE_PROGRESS = {
  lyrics: 15,
  sonic: 40,
  stems: 60,
  vocals: 75,
  master: 90,
  complete: 100,
} as const;

export type PipelineProgressStage = keyof typeof PIPELINE_PROGRESS;

export const PIPELINE_PROGRESS_LABELS: Record<PipelineProgressStage, string> = {
  lyrics: "Writing lyrics…",
  sonic: "Building the base track…",
  stems: "Separating stems…",
  vocals: "Rendering vocals…",
  master: "Mastering the mix…",
  complete: "Master track ready",
};

export type StudioProgressCallback = (stage: string, percent: number) => void;

export function normalizeProgressStage(stage: string): PipelineProgressStage | null {
  const key = stage.trim().toLowerCase();
  if (key in PIPELINE_PROGRESS) return key as PipelineProgressStage;
  if (key === "music" || key === "base" || key === "base audio") return "sonic";
  if (key === "mastering" || key === "matchering") return "master";
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
): void {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  console.log("[PROGRESS]", stage, clamped);
  onProgress?.(stage, clamped);
}
