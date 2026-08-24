import { describe, expect, it } from "vitest";
import { ffmpegContainerFlags } from "@/lib/matchering";

describe("Gate 6 Matchering helpers", () => {
  it("forces an explicit muxer for atomic tmp paths", () => {
    expect(ffmpegContainerFlags("mix.wav")).toEqual(["-f", "wav"]);
    expect(ffmpegContainerFlags("mix.wav.123.tmp.wav")).toEqual(["-f", "wav"]);
    expect(ffmpegContainerFlags("master.mp3.9.tmp.mp3")).toEqual(["-f", "mp3"]);
  });
});
