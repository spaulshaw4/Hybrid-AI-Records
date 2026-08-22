import { describe, expect, it } from "vitest";
import {
  ENGINE_PIPELINE_STEPS,
  enginePipelineIndex,
  enginePipelineStatus,
} from "@/lib/engine-pipeline";
import { MATCHERING_PROCESS_TIMEOUT_MS } from "@/lib/matchering";

describe("engine pipeline", () => {
  it("orders Stems → Mixing → Mastering → Complete", () => {
    expect(ENGINE_PIPELINE_STEPS.map((step) => step.label)).toEqual([
      "Stems",
      "Mixing",
      "Mastering",
      "Complete",
    ]);
    expect(enginePipelineIndex("mastering")).toBe(2);
    expect(enginePipelineStatus("stems")).toContain("intro & stems");
  });

  it("caps Matchering at 30 seconds so loudnorm can finish the master", () => {
    expect(MATCHERING_PROCESS_TIMEOUT_MS).toBe(30_000);
  });
});
