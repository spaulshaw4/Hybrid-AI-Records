import { describe, expect, it } from "vitest";
import { backingStemUrl, parseDemucsOutput } from "@/lib/stem-urls";

describe("parseDemucsOutput", () => {
  it("reads a stem dictionary", () => {
    expect(
      parseDemucsOutput({
        vocals: "https://replicate.delivery/vocals",
        drums: "https://replicate.delivery/drums",
        no_vocals: "https://replicate.delivery/backing",
      }),
    ).toEqual({
      vocals: "https://replicate.delivery/vocals",
      drums: "https://replicate.delivery/drums",
      other: "https://replicate.delivery/backing",
    });
  });

  it("reads filename-keyed stems", () => {
    const stems = parseDemucsOutput({
      "vocals.wav": "https://replicate.delivery/vocals.wav",
      "no_vocals.wav": "https://replicate.delivery/no_vocals.wav",
    });
    expect(stems.vocals).toBe("https://replicate.delivery/vocals.wav");
    expect(stems.other).toBe("https://replicate.delivery/no_vocals.wav");
  });

  it("treats a bare URL string as the vocal stem", () => {
    expect(parseDemucsOutput("https://replicate.delivery/only.mp3").vocals).toBe(
      "https://replicate.delivery/only.mp3",
    );
  });

  it("identifies stems by filename inside an array output", () => {
    const stems = parseDemucsOutput([
      "https://replicate.delivery/out/drums.mp3",
      "https://replicate.delivery/out/vocals.mp3",
      "https://replicate.delivery/out/no_vocals.mp3",
    ]);
    expect(stems.vocals).toBe("https://replicate.delivery/out/vocals.mp3");
    expect(stems.drums).toBe("https://replicate.delivery/out/drums.mp3");
    expect(stems.other).toBe("https://replicate.delivery/out/no_vocals.mp3");
  });

  it("ignores non-http values", () => {
    expect(parseDemucsOutput({ vocals: "/api/local-vault/vocals.mp3" }).vocals).toBeNull();
    expect(parseDemucsOutput(null)).toEqual({ vocals: null, drums: null, other: null });
  });

  it("never hands the isolated vocal back as the backing track", () => {
    expect(
      backingStemUrl({
        vocals: "https://replicate.delivery/vocals",
        drums: null,
        other: null,
      }),
    ).toBeNull();
  });
});
