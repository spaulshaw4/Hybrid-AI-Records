import { describe, expect, it } from "vitest";
import { CREST_WIDTHS, crestUrl, crestSrcSet, pickCrestWidth } from "@/lib/crest-sources";

describe("crest source selection", () => {
  it("only exposes the two shipped masters", () => {
    expect(crestUrl("usa", 1024)).toContain("usa-1024.webp");
    expect(crestUrl("usa", 4096)).toContain("usa-4096.webp");
    expect(crestSrcSet("nigeria")).toMatch(/nigeria-1024\.webp 1024w/);
    expect(crestSrcSet("nigeria")).toMatch(/nigeria-4096\.webp 4096w/);
    expect(crestSrcSet("nigeria").split(", ")).toHaveLength(CREST_WIDTHS.length);
  });

  it("keeps constrained tiers sharp instead of forcing a blurry thumbnail", () => {
    expect(
      pickCrestWidth({ viewportWidth: 2560, viewportHeight: 1440, dpr: 2, constrained: true }),
    ).toBe(1024);
  });

  it("caps high-density phones at 1024 instead of decoding a 4K master", () => {
    expect(pickCrestWidth({ viewportWidth: 390, viewportHeight: 844, dpr: 3, coarse: true })).toBe(
      1024,
    );
  });

  it("reserves the 4K master for large unconstrained screens", () => {
    expect(pickCrestWidth({ viewportWidth: 320, viewportHeight: 260, dpr: 1 })).toBe(1024);
    expect(pickCrestWidth({ viewportWidth: 1280, viewportHeight: 420, dpr: 1 })).toBe(1024);
    expect(pickCrestWidth({ viewportWidth: 1920, viewportHeight: 1200, dpr: 2 })).toBe(4096);
  });

  it("never exceeds the largest master and ignores absurd pixel ratios", () => {
    expect(pickCrestWidth({ viewportWidth: 4000, viewportHeight: 4000, dpr: 6 })).toBe(4096);
  });
});
