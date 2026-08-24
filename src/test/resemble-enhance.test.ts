import { describe, expect, it } from "vitest";
import {
  pickEnhancedAudioUrl,
  RESEMBLE_ENHANCE_DENOISE,
  RESEMBLE_ENHANCE_NFE,
  RESEMBLE_ENHANCE_SOLVER,
  RESEMBLE_ENHANCE_VERSION,
} from "@/lib/replicate-resemble-enhance.server";

describe("Resemble Enhance Gate 6", () => {
  it("pins the fast Euler / low-NFE / no-denoise settings", () => {
    expect(RESEMBLE_ENHANCE_VERSION).toBe(
      "93266a7e7f5805fb79bcf213b1a4e0ef2e45aff3c06eefd96c59e850c87fd6a2",
    );
    expect(RESEMBLE_ENHANCE_SOLVER).toBe("Euler");
    expect(RESEMBLE_ENHANCE_NFE).toBe(20);
    expect(RESEMBLE_ENHANCE_DENOISE).toBe(false);
  });

  it("picks output[1] || output[0] for [denoised, enhanced]", () => {
    expect(
      pickEnhancedAudioUrl([
        "https://replicate.delivery/denoised.wav",
        "https://replicate.delivery/enhanced.wav",
      ]),
    ).toBe("https://replicate.delivery/enhanced.wav");
    expect(pickEnhancedAudioUrl(["https://replicate.delivery/only.wav"])).toBe(
      "https://replicate.delivery/only.wav",
    );
  });

  it("accepts a single HTTPS output string", () => {
    expect(pickEnhancedAudioUrl("https://replicate.delivery/out.wav")).toBe(
      "https://replicate.delivery/out.wav",
    );
  });
});
