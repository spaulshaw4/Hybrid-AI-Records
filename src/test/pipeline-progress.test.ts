import { describe, expect, it, vi } from "vitest";
import {
  PIPELINE_PROGRESS,
  labelForProgressStage,
  reportPipelineProgress,
} from "@/lib/pipeline-progress";

describe("pipeline progress telemetry", () => {
  it("exposes the six-gate stage percents", () => {
    expect(PIPELINE_PROGRESS.lyrics).toBe(12);
    expect(PIPELINE_PROGRESS.sonic).toBe(28);
    expect(PIPELINE_PROGRESS.vault).toBe(40);
    expect(PIPELINE_PROGRESS.cwalo).toBe(52);
    expect(PIPELINE_PROGRESS.stems).toBe(65);
    expect(PIPELINE_PROGRESS.vocals).toBe(78);
    expect(PIPELINE_PROGRESS.master).toBe(92);
  });

  it("fires the onProgress callback and logs the stage", () => {
    const onProgress = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    reportPipelineProgress("sonic", PIPELINE_PROGRESS.sonic, onProgress);
    expect(onProgress).toHaveBeenCalledWith("sonic", 28, undefined);
    expect(log).toHaveBeenCalledWith("[PROGRESS]", "sonic", 28);
    expect(labelForProgressStage("sonic")).toContain("base track");
    log.mockRestore();
  });
});
