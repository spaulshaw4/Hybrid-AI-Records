import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { clampCinematicSeconds } from "@/lib/cinematic-seconds";
import { parseDirectedShotList, shotsToScenes } from "@/lib/cinematic-script-director";

const SHOT = {
  timestamp_start: 0,
  timestamp_end: 5,
  scene_type: "vocal close-up",
  prompt_flux: "A singer at a porch in late sun, face held steady.",
  motion_prompt: "The camera drifts closer while the singer leans into the lyric.",
};

describe("video shot list parser", () => {
  it("accepts a JSON list and keeps a 5 second shot at 5 seconds", () => {
    const shots = parseDirectedShotList(
      JSON.stringify([SHOT, { ...SHOT, timestamp_start: 5, timestamp_end: 11 }]),
    );
    expect(shots).toHaveLength(2);
    const scenes = shotsToScenes(shots, true);
    expect(scenes[0]?.seconds).toBe(5);
    expect(scenes[0]?.vocalSync).toBe(true);
    expect(scenes[1]?.seconds).toBe(clampCinematicSeconds(6));
    expect(scenes[0]?.stillPrompt).toContain("porch");
    expect(scenes[0]?.shot).toContain("camera");
  });

  it("fails generate when the reply is not a list", () => {
    expect(() => parseDirectedShotList(JSON.stringify({ shots: [SHOT] }))).toThrow(/JSON list/);
    expect(() => parseDirectedShotList("not json")).toThrow(/not JSON/);
    expect(() => parseDirectedShotList("[]")).toThrow(/empty/);
  });

  it("does not mark lip-sync when no vocal stem was uploaded", () => {
    const [scene] = shotsToScenes(parseDirectedShotList(JSON.stringify([SHOT])), false);
    expect(scene?.vocalSync).toBe(false);
  });

  it("pins the video script director to Claude on Replicate", () => {
    const source = readFileSync("src/lib/cinematic-script-director.server.ts", "utf8");
    expect(source).toContain("anthropic/claude-3.5-sonnet");
    expect(source).toContain("model: SCRIPT_DIRECTOR_MODEL");
    expect(source).toContain("maxTokens: SCRIPT_DIRECTOR_MAX_TOKENS");
    expect(source).toContain("temperature: SCRIPT_DIRECTOR_TEMPERATURE");
    expect(source).toContain("export const SCRIPT_DIRECTOR_MAX_TOKENS = 4000");
    expect(source).toContain("export const SCRIPT_DIRECTOR_TEMPERATURE = 0.7");
    expect(source).toContain("parseDirectedShotList");
    expect(source).not.toContain("wavespeed-ai/flux");
    expect(source).not.toContain("hailuo");
    expect(source).not.toContain("seedance");
    expect(source).not.toContain("veed/lipsync");
  });
});
