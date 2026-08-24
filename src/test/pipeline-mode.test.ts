import { describe, expect, it } from "vitest";
import { isStemPipelineEnabled, pipelineModeLabel } from "@/lib/pipeline-mode.server";

describe("pipeline mode (Gate 1→2→6 vs full stems)", () => {
  it("defaults to production short path when the stem toggle is unset", () => {
    expect(isStemPipelineEnabled({})).toBe(false);
    expect(pipelineModeLabel({})).toContain("short path");
  });

  it("enables Gates 3–5 when HYBRID_ENABLE_STEM_PIPELINE=1", () => {
    expect(isStemPipelineEnabled({ HYBRID_ENABLE_STEM_PIPELINE: "1" })).toBe(true);
    expect(isStemPipelineEnabled({ HYBRID_ENABLE_STEM_PIPELINE: "true" })).toBe(true);
    expect(pipelineModeLabel({ HYBRID_ENABLE_STEM_PIPELINE: "1" })).toContain("stem pipeline");
  });

  it("respects an explicit off switch", () => {
    expect(isStemPipelineEnabled({ HYBRID_ENABLE_STEM_PIPELINE: "0" })).toBe(false);
    expect(isStemPipelineEnabled({ PIPELINE_ENABLE_STEMS: "off" })).toBe(false);
  });
});
