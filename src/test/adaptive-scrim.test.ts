import { describe, expect, it } from "vitest";
import { activeLayerIndex, scrimForLuminance } from "@/lib/adaptive-scrim";

describe("adaptive scrim", () => {
  it("keeps the veil light over dark crests", () => {
    const dark = scrimForLuminance(0.05);
    expect(dark.opacity).toBeCloseTo(0.62, 2);
    expect(dark.blur).toBe(0);
  });

  it("strengthens the veil and adds blur over bright crests", () => {
    const bright = scrimForLuminance(0.7);
    expect(bright.opacity).toBeGreaterThan(1.4);
    expect(bright.blur).toBeGreaterThan(8);
  });

  it("ramps monotonically between the two extremes", () => {
    const values = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6].map((l) => scrimForLuminance(l).opacity);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    }
  });

  it("maps elapsed time to the crest currently peaking", () => {
    expect(activeLayerIndex(0, 4, 32000)).toBe(0);
    expect(activeLayerIndex(9000, 4, 32000)).toBe(1);
    expect(activeLayerIndex(31999, 4, 32000)).toBe(3);
    expect(activeLayerIndex(32000, 4, 32000)).toBe(0);
    expect(activeLayerIndex(50000, 1, 32000)).toBe(0);
  });
});
