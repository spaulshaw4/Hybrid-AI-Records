import { describe, expect, it } from "vitest";
import { ACE_STEP_MODEL } from "@/lib/ace-step-payload";
import {
  REPLICATE_COMMUNITY_PREDICTIONS_PATH,
  REPLICATE_COST_EFFECTIVE_GPU,
  communityPredictionBody,
  officialModelPredictionsPath,
  replicateRunHeaders,
} from "@/lib/replicate-predictions";

describe("replicate prediction routes", () => {
  it("keeps official music models on the official create path", () => {
    expect(officialModelPredictionsPath("elevenlabs/music")).toBe(
      "/models/elevenlabs/music/predictions",
    );
    expect(officialModelPredictionsPath("minimax/music-2.6")).toBe(
      "/models/minimax/music-2.6/predictions",
    );
  });

  it("does not send ACE-Step through the official-model create path", () => {
    expect(officialModelPredictionsPath("elevenlabs/music")).not.toContain(ACE_STEP_MODEL);
    expect(communityPredictionBody("abc", { prompt: "x" })).toEqual({
      version: "abc",
      input: { prompt: "x" },
    });
    expect(communityPredictionBody("abc", { prompt: "x" }, { hardware: "gpu-t4" })).toEqual({
      version: "abc",
      input: { prompt: "x" },
      hardware: "gpu-t4",
    });
    expect(REPLICATE_COMMUNITY_PREDICTIONS_PATH).toBe("/predictions");
    expect(REPLICATE_COST_EFFECTIVE_GPU).toBe("gpu-t4");
    expect(replicateRunHeaders(120_000)).toEqual({
      "Cancel-After": "120s",
      Prefer: "wait=5",
    });
    // A long sync hold invites a client disconnect, which Replicate records as
    // an aborted prediction, so the wait stays short regardless of the ceiling.
    expect(replicateRunHeaders(300_000)).toEqual({
      "Cancel-After": "300s",
      Prefer: "wait=5",
    });
    expect(officialModelPredictionsPath("minimax/music-2.6")).not.toBe(
      `/models/${ACE_STEP_MODEL}/predictions`,
    );
  });
});
