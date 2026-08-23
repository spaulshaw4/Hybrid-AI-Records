import { describe, expect, it } from "vitest";
import {
  formatVocalDuration,
  isLocalVocalProfileId,
  vocalProfileStorageKey,
} from "@/lib/vocal-profile-store";

describe("vocal profile helpers", () => {
  it("builds hybrid_vocal_profile_${id} keys", () => {
    expect(vocalProfileStorageKey("abc")).toBe("hybrid_vocal_profile_abc");
    expect(isLocalVocalProfileId("hybrid_vocal_profile_abc")).toBe(true);
    expect(isLocalVocalProfileId("voice_cloud")).toBe(false);
  });

  it("formats duration as m:ss", () => {
    expect(formatVocalDuration(0)).toBe("0:00");
    expect(formatVocalDuration(5)).toBe("0:05");
    expect(formatVocalDuration(32)).toBe("0:32");
    expect(formatVocalDuration(90.4)).toBe("1:30");
  });
});
