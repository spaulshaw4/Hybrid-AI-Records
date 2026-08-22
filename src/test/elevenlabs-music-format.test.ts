import { describe, expect, it } from "vitest";
import {
  ELEVENLABS_MUSIC_OUTPUT_FORMATS,
  elevenLabsMusicOutputFormat,
} from "@/lib/elevenlabs-music-format";

describe("elevenLabsMusicOutputFormat", () => {
  it("uses Replicate's named MP3 quality, not a codec bitrate string", () => {
    expect(elevenLabsMusicOutputFormat("mp3")).toBe("mp3_high_quality");
    expect(elevenLabsMusicOutputFormat(undefined)).toBe("mp3_high_quality");
    expect(elevenLabsMusicOutputFormat("mp3")).not.toContain("44100");
  });

  it("keeps WAV at CD quality", () => {
    expect(elevenLabsMusicOutputFormat("wav")).toBe("wav_cd_quality");
  });

  it("only emits values from the hosted schema", () => {
    expect(ELEVENLABS_MUSIC_OUTPUT_FORMATS).toContain(elevenLabsMusicOutputFormat("mp3"));
    expect(ELEVENLABS_MUSIC_OUTPUT_FORMATS).toContain(elevenLabsMusicOutputFormat("wav"));
  });
});
