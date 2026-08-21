import { describe, expect, it } from "vitest";
import {
  MIN_CONTRAST_RATIO,
  contrastRatio,
  effectiveBackgroundLuminance,
  glowGuard,
} from "@/lib/glow-contrast";

describe("glow contrast guard", () => {
  it("leaves the glow untouched over a dark crest", () => {
    const guard = glowGuard(0.05, 1, 1);
    expect(guard.scale).toBe(1);
    expect(guard.fallback).toBe(false);
    expect(guard.ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
  });

  it("clamps the glow and flags the fallback over a bright crest", () => {
    const guard = glowGuard(0.75, 0.7, 2);
    expect(guard.scale).toBeLessThan(1);
    expect(guard.fallback).toBe(true);
  });

  it("never returns a level below AA when any level passes", () => {
    for (const crest of [0.1, 0.3, 0.5, 0.7]) {
      const guard = glowGuard(crest, 1, 1.5);
      if (guard.scale > 0) {
        expect(guard.ratio).toBeGreaterThanOrEqual(MIN_CONTRAST_RATIO);
      }
    }
  });

  it("a heavier scrim lets more crest be hidden", () => {
    expect(effectiveBackgroundLuminance(0.6, 1.4)).toBeLessThan(
      effectiveBackgroundLuminance(0.6, 0.6),
    );
  });

  it("computes WCAG ratios", () => {
    expect(contrastRatio(1, 0)).toBeCloseTo(21, 5);
  });
});
