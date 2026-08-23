import { describe, expect, it } from "vitest";
import { HYBRID_INTRO_SECONDS } from "@/lib/hybrid-track-pipeline";
import {
  BRICKWALL_LIMITER,
  MATCHERING_FINISH_FILTER,
  MATCHERING_PIPELINE_TIMEOUT_MS,
  MATCHERING_REFERENCE_RELATIVE,
  MATCHERING_SCRIPT_RELATIVE,
  MASTER_FADE_OUT_SECONDS,
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
    expect(graph).toContain("[inst][vox]amix=inputs=2");
    expect(graph).toContain("[intro][core]concat=n=2:v=0:a=1[out]");
  });

  it("mixes Demucs backing with Fish vocals when there is no intro", () => {
    const graph = buildHybridMixFilterComplex([
      { kind: "instrumental", path: "b" },
      { kind: "vocal", path: "c" },
    ]);
    expect(graph).toContain("volume=1.0");
    expect(graph).toContain(
      "[inst][vox]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,loudnorm=I=-14:LRA=11:TP=-1.5[core]",
    );
    expect(graph).toContain("[core]anull[out]");
    expect(graph).not.toContain("concat=");
    expect(graph).not.toContain("dropout_transition=2");
    expect(graph).not.toContain("duration=longest");
    expect(graph).not.toContain("normalize=1");
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
      "--timeout",
      "30",
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
      "-ac",
      "2",
      "-ar",
      "44100",
      "-b:a",
      "320k",
      "out.mp3",
    ]);
  });

  it("forces Gate 6 stereo 44.1 kHz and -shortest on multi-stem remux", () => {
    const args = buildHybridMixArgs(
      { instrumentalPath: "m.wav", vocalPath: "v.wav" },
      "mix.wav",
    );
    expect(args).toContain("-shortest");
    expect(args).toContain("-ac");
    expect(args[args.indexOf("-ac") + 1]).toBe("2");
    expect(args).toContain("-ar");
    expect(args[args.indexOf("-ar") + 1]).toBe("44100");
  });

  it("cuts the master at the requested length with a fade into the cut", () => {
    const args = matcheringFinishArgs("in.wav", "out.mp3", 180);
    // A 3 minute request must not come back longer than 3 minutes.
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("180");
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain(
      `afade=t=out:st=${180 - MASTER_FADE_OUT_SECONDS}:d=${MASTER_FADE_OUT_SECONDS}:curve=exp`,
    );
    expect(filter).toContain("loudnorm=I=-14");
  });

  it("applies a 4s exponential fade-out when only duration is known", () => {
    const args = matcheringFinishArgs("in.wav", "out.mp3", undefined, {
      durationSeconds: 120,
    });
    expect(args).not.toContain("-t");
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain(
      `afade=t=out:st=${120 - MASTER_FADE_OUT_SECONDS}:d=${MASTER_FADE_OUT_SECONDS}:curve=exp`,
    );
  });

  it("anchors a 2.5s fade at CWALO track_end and never fades at outro_start", () => {
    const args = matcheringFinishArgs("in.wav", "out.mp3", 180, {
      trackEnd: 165,
      fadeOutSeconds: 2.5,
    });
    expect(args).toContain("-t");
    expect(args[args.indexOf("-t") + 1]).toBe("165");
    const filter = args[args.indexOf("-af") + 1];
    expect(filter).toContain("afade=t=out:st=162.5:d=2.5:curve=exp");
    expect(filter).not.toContain("st=161"); // would be outro_start-ish early fade
  });

  it("applies CWALO section volume envelopes during remux", () => {
    const graph = buildHybridMixFilterComplex(
      [
        { kind: "instrumental", path: "b" },
        { kind: "vocal", path: "c" },
      ],
      HYBRID_INTRO_SECONDS,
      {
        instrumentalVolumeExpr: "if(between(t\\,8\\,24)\\,0.88\\,1.0)",
        vocalVolumeExpr: "if(between(t\\,8\\,24)\\,1.12\\,1.0)",
      },
    );
    expect(graph).toContain("volume='if(between(t\\,8\\,24)\\,0.88\\,1.0)':eval=frame");
    expect(graph).toContain("volume='if(between(t\\,8\\,24)\\,1.12\\,1.0)':eval=frame");
    expect(graph).toContain("normalize=0");
  });

  it("leaves the master untouched when no ceiling is requested", () => {
    const args = matcheringFinishArgs("in.wav", "out.mp3");
    expect(args).not.toContain("-t");
    expect(args[args.indexOf("-af") + 1]).toBe(MATCHERING_FINISH_FILTER);
  });

  it("ignores a ceiling shorter than the fade itself", () => {
    const args = matcheringFinishArgs("in.wav", "out.mp3", 2);
    expect(args).not.toContain("-t");
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
    expect(MATCHERING_PIPELINE_TIMEOUT_MS).toBe(90_000);
  });
});
