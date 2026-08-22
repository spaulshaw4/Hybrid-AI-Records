import { describe, expect, it } from "vitest";
import {
  backingStemUrl,
  generationCompletesAfterMaster,
  parseDemucsOutput,
} from "@/lib/stem-urls";
import { buildVocalClonePayload } from "@/lib/vocal-clone-payload";

describe("Demucs stem mapping", () => {
  it("prefers no_vocals / accompaniment as the Matchering backing stem", () => {
    expect(
      parseDemucsOutput({
        vocals: "https://cdn.example/vocals.mp3",
        no_vocals: "https://cdn.example/backing.mp3",
        drums: "https://cdn.example/drums.mp3",
      }),
    ).toEqual({
      vocals: "https://cdn.example/vocals.mp3",
      drums: "https://cdn.example/drums.mp3",
      other: "https://cdn.example/backing.mp3",
    });
    expect(
      backingStemUrl({
        vocals: "https://cdn.example/vocals.mp3",
        drums: "https://cdn.example/drums.mp3",
        other: "https://cdn.example/backing.mp3",
      }),
    ).toBe("https://cdn.example/backing.mp3");
  });
});

describe("generation completion", () => {
  it("marks complete only after Matchering mixed a master URL", () => {
    expect(generationCompletesAfterMaster({ masterUrl: "https://cdn/master.mp3", mixed: true })).toBe(
      true,
    );
    expect(generationCompletesAfterMaster({ masterUrl: "https://cdn/raw.mp3", mixed: false })).toBe(
      false,
    );
    expect(generationCompletesAfterMaster({ masterUrl: null, mixed: true })).toBe(false);
  });
});

describe("Fish Audio vocal payload", () => {
  it("sends the isolated vocal and artist reference to native Fish TTS", () => {
    const isolated = new Uint8Array(512).fill(1);
    const reference = new Uint8Array(512).fill(2);
    const payload = buildVocalClonePayload({
      text: "hold the line",
      audio: isolated,
      extraReferences: [reference],
      format: "mp3",
    });
    expect(payload.references).toHaveLength(2);
    expect(payload.references?.[0]?.audio).toBe(isolated);
    expect(payload.references?.[0]?.text).toContain("hold the line");
    expect(payload.references?.[1]?.audio).toBe(reference);
    expect(payload.text).toBe("hold the line");
  });
});
