import { describe, expect, it, vi } from "vitest";
import {
  PIPELINE_PROGRESS,
  labelForProgressStage,
  reportPipelineProgress,
} from "@/lib/pipeline-progress";

describe("pipeline progress telemetry", () => {
  it("exposes the five stage percents", () => {
    expect(PIPELINE_PROGRESS.lyrics).toBe(15);
    expect(PIPELINE_PROGRESS.sonic).toBe(40);
    expect(PIPELINE_PROGRESS.stems).toBe(60);
    expect(PIPELINE_PROGRESS.vocals).toBe(75);
    expect(PIPELINE_PROGRESS.master).toBe(90);
  });

  it("fires the onProgress callback and logs the stage", () => {
    const onProgress = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    reportPipelineProgress("sonic", PIPELINE_PROGRESS.sonic, onProgress);
    expect(onProgress).toHaveBeenCalledWith("sonic", 40);
    expect(log).toHaveBeenCalledWith("[PROGRESS]", "sonic", 40);
    expect(labelForProgressStage("sonic")).toContain("base track");
    log.mockRestore();
  });
});
