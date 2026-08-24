import { describe, expect, it } from "vitest";
import {
  pickRvcVocalUrl,
  RVC_F0_METHOD,
  RVC_INDEX_RATE,
  RVC_MODEL_NAME,
  RVC_PITCH_CHANGE,
  RVC_PROTECT,
  RVC_VERSION,
  resolveRvcModelDownloadUrl,
} from "@/lib/replicate-rvc.server";

describe("Gate 5 RVC", () => {
  it("pins the pitch-preserving RVC settings", () => {
    expect(RVC_VERSION).toBe(
      "0a9c7c558af4c0f20667c1bd12600e5a1ddc443424d84d2d6077896176583e7d",
    );
    expect(RVC_MODEL_NAME).toBe("CUSTOM");
    expect(RVC_PITCH_CHANGE).toBe("no-change");
    expect(RVC_INDEX_RATE).toBe(0.5);
    expect(RVC_PROTECT).toBe(0.33);
    expect(RVC_F0_METHOD).toBe("rmvpe");
  });

  it("treats rvcOutput as a finished vocal stem URL", () => {
    expect(pickRvcVocalUrl("https://replicate.delivery/vocals.mp3")).toBe(
      "https://replicate.delivery/vocals.mp3",
    );
    expect(pickRvcVocalUrl(["https://replicate.delivery/a.mp3"])).toBe(
      "https://replicate.delivery/a.mp3",
    );
  });

  it("prefers an explicit rvcModelUrl over empty env", () => {
    expect(resolveRvcModelDownloadUrl("https://cdn.example/model.zip")).toBe(
      "https://cdn.example/model.zip",
    );
  });
});
