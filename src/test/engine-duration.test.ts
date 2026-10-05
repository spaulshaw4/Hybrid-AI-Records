import { describe, expect, it } from "vitest";

import { generationTokenCharge } from "@/lib/token-alerts";
import {
  DEFAULT_TARGET_DURATION_SECONDS,
  ENGINE_DURATION_MIN_SECONDS,
  ENGINE_DURATION_STEP_SECONDS,
  MAX_TARGET_DURATION_SECONDS,
  clampDurationPreset,
  formatDuration,
} from "@/lib/track-length";

describe("engine duration slider", () => {
  it("accepts 90 through 420 in steps of 30 and always costs 1 token", () => {
    expect(ENGINE_DURATION_MIN_SECONDS).toBe(90);
    expect(ENGINE_DURATION_STEP_SECONDS).toBe(30);
    expect(MAX_TARGET_DURATION_SECONDS).toBe(420);
    expect(DEFAULT_TARGET_DURATION_SECONDS).toBe(210);

    for (let seconds = 90; seconds <= 420; seconds += 30) {
      expect(clampDurationPreset(seconds)).toBe(seconds);
      expect(generationTokenCharge(seconds)).toBe(1);
    }

    expect(formatDuration(90)).toBe("1 min 30 sec");
    expect(formatDuration(120)).toBe("2 min");
    expect(formatDuration(210)).toBe("3 min 30 sec");
    expect(formatDuration(300)).toBe("5 min");
    expect(formatDuration(420)).toBe("7 min");

    expect(clampDurationPreset(50)).toBe(90);
    expect(clampDurationPreset(999)).toBe(420);
    expect(clampDurationPreset(Number.NaN)).toBe(210);
    for (const offGrid of [100, 215, 410]) {
      expect(() => clampDurationPreset(offGrid)).toThrow(/steps of 30/);
    }
    expect(generationTokenCharge(90)).toBe(1);
    expect(generationTokenCharge(420)).toBe(1);
  });
});
