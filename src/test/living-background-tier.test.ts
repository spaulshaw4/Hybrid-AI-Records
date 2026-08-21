import { describe, expect, it } from "vitest";
import {
  detectLivingBackgroundTier,
  isIosUserAgent,
} from "@/lib/living-background-tier";
import { DIVISION_WATERMARKS } from "@/components/LivingBackground";

describe("living background tier", () => {
  it("treats iOS as lite even when deviceMemory is missing", () => {
    expect(
      detectLivingBackgroundTier({
        isIOS: true,
        cores: 6,
        innerWidth: 1024,
      }),
    ).toBe("lite");
  });

  it("treats a coarse pointer as lite without waiting for RAM hints", () => {
    expect(detectLivingBackgroundTier({ coarse: true, cores: 8 })).toBe("lite");
  });

  it("treats a phone-width viewport as lite", () => {
    expect(detectLivingBackgroundTier({ innerWidth: 390, cores: 8 })).toBe("lite");
  });

  it("goes static for reduced motion, Save-Data, 2g, or Safe Mode", () => {
    expect(detectLivingBackgroundTier({ reducedMotion: true })).toBe("static");
    expect(detectLivingBackgroundTier({ saveData: true })).toBe("static");
    expect(detectLivingBackgroundTier({ effectiveType: "2g" })).toBe("static");
    expect(detectLivingBackgroundTier({ safeMode: true, isIOS: false, cores: 16 })).toBe("static");
  });

  it("keeps capable desktops on full", () => {
    expect(
      detectLivingBackgroundTier({
        cores: 8,
        deviceMemory: 8,
        innerWidth: 1440,
        coarse: false,
        isIOS: false,
      }),
    ).toBe("full");
  });

  it("recognises iPhone and iPadOS user agents", () => {
    expect(isIosUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(true);
    expect(isIosUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5)).toBe(true);
    expect(isIosUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 0)).toBe(false);
  });

  it("cycles one watermark at a time: Hybrid AI → Jester → Lithuania → Nigeria", () => {
    expect(DIVISION_WATERMARKS.map((crest) => crest.name)).toEqual([
      "usa",
      "jester",
      "lithuania",
      "nigeria",
    ]);
  });
});
