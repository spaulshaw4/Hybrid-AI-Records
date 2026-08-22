import { describe, expect, it } from "vitest";
import { explainEngineFailure } from "@/lib/engine-failure";

describe("explainEngineFailure", () => {
  it("does not treat a 422 engine body as a slider-range problem", () => {
    const explained = explainEngineFailure(
      new Error("Music engine: Input is invalid (422)"),
    );
    expect(explained.headline).toBe("The music engine rejected this request");
    expect(explained.message).toContain("Input is invalid");
    expect(explained.message).not.toContain("sliders");
  });

  it("does not treat timeout 240000 as HTTP 400", () => {
    const explained = explainEngineFailure(
      new Error("Music engine: temporarily unreachable (timeout 240000)"),
    );
    expect(explained.kind).toBe("timeout");
  });

  it("keeps lyrics-required as a lyrics problem", () => {
    const explained = explainEngineFailure(
      new Error("Vocal lyrics are required to generate a master track."),
    );
    expect(explained.headline).toBe("Lyrics are missing");
  });
});
