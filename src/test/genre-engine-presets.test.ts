import { describe, expect, it } from "vitest";
import { DEFAULT_BPM, DEFAULT_INFLUENCE } from "@/lib/engine-controls";
import { DEFAULT_GENRE_PRESET, presetForGenres } from "@/lib/genre-engine-presets";

describe("presetForGenres", () => {
  it("returns the studio baseline when no genre is selected", () => {
    expect(presetForGenres([])).toEqual(DEFAULT_GENRE_PRESET);
    expect(presetForGenres([]).bpm).toBe(DEFAULT_BPM);
    expect(presetForGenres([]).audioInfluence).toBe(DEFAULT_INFLUENCE);
  });

  it("loads Trap at a faster tempo than Heavy Rock", () => {
    const trap = presetForGenres(["Trap"]);
    const rock = presetForGenres(["Heavy Rock"]);
    expect(trap.bpm).toBeGreaterThan(rock.bpm);
    expect(trap.bpm).toBe(140);
    expect(rock.bpm).toBe(92);
  });

  it("uses the most recently selected genre when several are blended", () => {
    expect(presetForGenres(["Heavy Rock", "Trap"]).bpm).toBe(140);
    expect(presetForGenres(["Trap", "Heavy Rock"]).bpm).toBe(92);
  });

  it("falls back to a family preset for catalog genres without a named row", () => {
    const drill = presetForGenres(["Boom Bap"]);
    expect(drill.bpm).toBeGreaterThanOrEqual(130);
  });
});
