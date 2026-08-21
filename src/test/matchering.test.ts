import { describe, expect, it } from "vitest";
import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import {
  BRICKWALL_LIMITER,
  MATCHERING_FINISH_FILTER,
  MATCHERING_PIPELINE_TIMEOUT_MS,
  MATCHERING_REFERENCE_RELATIVE,
  MATCHERING_SCRIPT_RELATIVE,
  buildHybridMixArgs,
  buildHybridMixFilterComplex,
  collectHybridStems,
  matcheringFinishArgs,
  matcheringPythonArgs,
  masteredPlayablePath,
  masteredPcmPath,
} from "@/lib/matchering";
import { masteredTrackObjectPath } from "@/lib/audio-vault";

describe("Matchering 2.0 mix + master contract", () => {
  it("collects intro, MiniMax instrumental, and Fish vocal stems in order", () => {
    expect(
      collectHybridStems({
        introPath: "intro.wav",
        instrumentalPath: "inst.wav",
        vocalPath: "voc.wav",
      }).map((slot) => slot.kind),
    ).toEqual(["intro", "instrumental", "vocal"]);
  });

  it("builds a concat+amix graph for the three Hybrid Engine stems", () => {
    const graph = buildHybridMixFilterComplex([
      { kind: "intro", path: "a" },
      { kind: "instrumental", path: "b" },
      { kind: "vocal", path: "c" },
    ]);
    expect(graph).toContain(`atrim=0:${HYBRID_INTRO_SECONDS}`);
    expect(graph).toContain("[inst][voc]amix=inputs=2");
    expect(graph).toContain("[intro][core]concat=n=2:v=0:a=1[out]");
  });

  it("encodes the mix as 24-bit 44.1 kHz stereo PCM", () => {
    const args = buildHybridMixArgs(
      { introPath: "i.wav", instrumentalPath: "m.wav", vocalPath: "v.wav" },
      "mix.wav",
    );
    expect(args).toContain("-filter_complex");
    expect(args).toContain("pcm_s24le");
    expect(args).toContain("mix.wav");
  });

  it("invokes the Matchering Python wrapper with target, reference, and pcm24 out", () => {
    expect(
      matcheringPythonArgs({
        scriptPath: MATCHERING_SCRIPT_RELATIVE,
        target: "mix.wav",
        reference: MATCHERING_REFERENCE_RELATIVE,
        outWav: "master.wav",
      }),
    ).toEqual([
      "scripts/matchering_master.py",
      "--target",
      "mix.wav",
      "--reference",
      "public/references/master_reference.wav",
      "--out-wav",
      "master.wav",
    ]);
  });

  it("applies brickwall limiting and -14 LUFS on the playable MP3", () => {
    expect(BRICKWALL_LIMITER).toContain("alimiter");
    expect(MATCHERING_FINISH_FILTER).toContain("loudnorm=I=-14");
    expect(matcheringFinishArgs("in.wav", "out.mp3")).toEqual([
      "-y",
      "-hide_banner",
      "-nostdin",
      "-i",
      "in.wav",
      "-af",
      MATCHERING_FINISH_FILTER,
      "-b:a",
      "320k",
      "out.mp3",
    ]);
  });

  it("stores playable masters under mastered_tracks/", () => {
    expect(masteredTrackObjectPath("user-1", "task-9", "mp3")).toBe(
      "mastered_tracks/user-1/task-9_master.mp3",
    );
    expect(masteredPlayablePath("user-1", "task-9")).toBe(
      "mastered_tracks/user-1/task-9_master.mp3",
    );
    expect(masteredPcmPath("user-1", "task-9")).toBe(
      "mastered_tracks/user-1/task-9_master.wav",
    );
  });

  it("caps the pipeline so a stuck worker cannot hang generation", () => {
    expect(MATCHERING_PIPELINE_TIMEOUT_MS).toBe(180_000);
  });
});
