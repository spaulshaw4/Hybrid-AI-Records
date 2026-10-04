import { describe, expect, it } from "vitest";

import { generationTokenCharge } from "@/lib/token-alerts";
import {
  DEFAULT_TARGET_DURATION_SECONDS,
  ENGINE_DURATION_MIN_SECONDS,
  ENGINE_DURATION_STEP_SECONDS,
  MAX_TARGET_DURATION_SECONDS,
  clampDurationPreset,
} from "@/lib/track-length";

describe("engine duration slider", () => {
  it("accepts 90 through 420 in steps of 10 and always costs 1 token", () => {
    expect(ENGINE_DURATION_MIN_SECONDS).toBe(90);
    expect(ENGINE_DURATION_STEP_SECONDS).toBe(10);
    expect(MAX_TARGET_DURATION_SECONDS).toBe(420);
    expect(DEFAULT_TARGET_DURATION_SECONDS).toBe(210);

    for (const seconds of [90, 100, 180, 210, 240, 300, 410, 420]) {
      expect(clampDurationPreset(seconds)).toBe(seconds);
      expect(generationTokenCharge(seconds)).toBe(1);
    }

    expect(clampDurationPreset(50)).toBe(90);
    expect(clampDurationPreset(215)).toBe(220);
    expect(clampDurationPreset(999)).toBe(420);
    expect(clampDurationPreset(Number.NaN)).toBe(210);
    expect(generationTokenCharge(90)).toBe(1);
    expect(generationTokenCharge(420)).toBe(1);
  });
});
