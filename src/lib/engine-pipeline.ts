/**
 * Hybrid Engine on-screen pipeline. The studio shows these four stages
 * while a generate is in flight — never Cancel / Delete mid-render.
 */

export const ENGINE_PIPELINE_STEPS = [
  {
    id: "stems",
    label: "Stems",
    status: "Generating intro & stems...",
  },
  {
    id: "mixing",
    label: "Mixing",
    status: "Mixing audio stems (FFmpeg)...",
  },
  {
    id: "mastering",
    label: "Mastering",
    status: "Running Matchering 2.0 mastering pass...",
  },
  {
    id: "complete",
    label: "Complete",
    status: "Uploading to vault & preparing player...",
  },
] as const;

export type EnginePipelineStepId = (typeof ENGINE_PIPELINE_STEPS)[number]["id"];

export function enginePipelineStatus(id: EnginePipelineStepId): string {
  return ENGINE_PIPELINE_STEPS.find((step) => step.id === id)?.status ?? ENGINE_PIPELINE_STEPS[0].status;
}

export function enginePipelineIndex(id: EnginePipelineStepId): number {
  const index = ENGINE_PIPELINE_STEPS.findIndex((step) => step.id === id);
  return index < 0 ? 0 : index;
}
