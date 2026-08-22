import { describe, expect, it } from "vitest";
import { ACE_STEP_MODEL } from "@/lib/ace-step-payload";
import {
  REPLICATE_COMMUNITY_PREDICTIONS_PATH,
  communityPredictionBody,
  officialModelPredictionsPath,
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
    expect(REPLICATE_COMMUNITY_PREDICTIONS_PATH).toBe("/predictions");
    expect(officialModelPredictionsPath("minimax/music-2.6")).not.toBe(
      `/models/${ACE_STEP_MODEL}/predictions`,
    );
  });
});
