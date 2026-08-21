import { describe, expect, it } from "vitest";
import {
  LOUDNORM_FILTER,
  MASTER_AUDIO_BITRATE,
  finalizeTrackMasterArgs,
  loudnormTwoPassFilter,
  measureLoudnormArgs,
  parseLoudnormMeasurement,
} from "@/lib/loudnorm";

describe("loudnorm master", () => {
  it("targets -14 LUFS with a -1.5 dB true-peak ceiling", () => {
    expect(LOUDNORM_FILTER).toBe("loudnorm=I=-14:TP=-1.5:LRA=11");
    expect(MASTER_AUDIO_BITRATE).toBe("320k");
  });

  it("builds the FFmpeg encode command", () => {
    expect(finalizeTrackMasterArgs("in.wav", "out.mp3")).toEqual([
      "-y",
      "-hide_banner",
      "-nostdin",
      "-i",
      "in.wav",
      "-af",
      "loudnorm=I=-14:TP=-1.5:LRA=11",
      "-b:a",
      "320k",
      "out.mp3",
    ]);
  });

  it("parses loudnorm measurement JSON from FFmpeg stderr", () => {
    const stderr = `...noise...
{
	"input_i" : "-18.31",
	"input_tp" : "-2.10",
	"input_lra" : "8.40",
	"input_thresh" : "-28.12",
	"output_i" : "-14.02",
	"target_offset" : "0.21"
}
`;
    expect(parseLoudnormMeasurement(stderr)).toEqual({
      input_i: "-18.31",
      input_tp: "-2.10",
      input_lra: "8.40",
      input_thresh: "-28.12",
      target_offset: "0.21",
    });
  });

  it("builds a linear second-pass filter from measured stats", () => {
    expect(
      loudnormTwoPassFilter({
        input_i: "-18.31",
        input_tp: "-2.10",
        input_lra: "8.40",
        input_thresh: "-28.12",
        target_offset: "0.21",
      }),
    ).toBe(
      "loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=-18.31:measured_TP=-2.10:measured_LRA=8.40:measured_thresh=-28.12:offset=0.21:linear=true",
    );
  });

  it("measures loudness without writing a file", () => {
    expect(measureLoudnormArgs("in.mp3").slice(-3)).toEqual(["-f", "null", "-"]);
  });
});
