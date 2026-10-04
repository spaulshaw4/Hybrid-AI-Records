import { describe, expect, it } from "vitest";

import { shouldProcessVoice } from "@/lib/voice-process-client";

describe("shouldProcessVoice", () => {
  const take = new Blob([new Uint8Array(128)], { type: "audio/wav" });

  it("skips when there is no recording", () => {
    expect(shouldProcessVoice(null, "neon rain")).toBe(false);
    expect(shouldProcessVoice(undefined, "neon rain")).toBe(false);
  });

  it("skips an empty script even if a take exists", () => {
    expect(shouldProcessVoice(take, "   ")).toBe(false);
  });

  it("sends only when a take and lyrics both exist", () => {
    expect(shouldProcessVoice(take, "neon rain")).toBe(true);
  });
});
