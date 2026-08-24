import { describe, expect, it } from "vitest";
import {
  pickEnhancedAudioUrl,
  RESEMBLE_ENHANCE_VERSION,
} from "@/lib/replicate-resemble-enhance.server";

describe("Resemble Enhance Gate 6", () => {
  it("pins the Replicate version Stephen specified", () => {
    expect(RESEMBLE_ENHANCE_VERSION).toBe(
      "93266a7e7f5805fb79bcf213b1a4e0ef2e45aff3c06eefd96c59e850c87fd6a2",
    );
  });

  it("prefers the enhanced URI when denoised + enhanced are returned", () => {
    expect(
      pickEnhancedAudioUrl([
        "https://replicate.delivery/denoised.wav",
        "https://replicate.delivery/enhanced.wav",
      ]),
    ).toBe("https://replicate.delivery/enhanced.wav");
  });

  it("accepts a single HTTPS output string", () => {
    expect(pickEnhancedAudioUrl("https://replicate.delivery/out.wav")).toBe(
      "https://replicate.delivery/out.wav",
    );
  });
});
