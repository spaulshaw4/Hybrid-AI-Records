import { describe, expect, it } from "vitest";
import { SEEK_EPSILON, sameMoment, shouldSeek, shouldWritePosition } from "@/lib/radio-positions";

describe("idempotent seek events", () => {
  it("drops a duplicate seek to the position already playing", () => {
    expect(shouldSeek(42, 42)).toBe(false);
  });

  it("drops jitter within the epsilon window (slider change + input pairs)", () => {
    expect(shouldSeek(42, 42 + SEEK_EPSILON / 2)).toBe(false);
    expect(shouldSeek(42, 42 - SEEK_EPSILON / 2)).toBe(false);
  });

  it("applies a real jump", () => {
    expect(shouldSeek(42, 90)).toBe(true);
    expect(shouldSeek(42, 0)).toBe(true);
  });

  it("applies a nudge just past the epsilon window", () => {
    expect(shouldSeek(42, 42 + SEEK_EPSILON * 2)).toBe(true);
  });

  it("ignores malformed targets instead of seeking to NaN", () => {
    expect(shouldSeek(10, Number.NaN)).toBe(false);
    expect(shouldSeek(10, Number.POSITIVE_INFINITY)).toBe(false);
    expect(shouldSeek(10, -5)).toBe(false);
  });

  it("stays a no-op when the same seek is replayed repeatedly", () => {
    let playhead = 0;
    for (const target of [120, 120, 120, 120]) {
      if (shouldSeek(playhead, target)) playhead = target;
    }
    expect(playhead).toBe(120);
    expect(shouldSeek(playhead, 120)).toBe(false);
  });

  it("treats sameMoment symmetrically", () => {
    expect(sameMoment(10, 10.1)).toBe(sameMoment(10.1, 10));
  });
});

describe("idempotent resume-point writes", () => {
  it("writes the first resume point for a track", () => {
    expect(shouldWritePosition(undefined, 30)).toBe(true);
  });

  it("skips restamping when the saved point is unchanged", () => {
    expect(shouldWritePosition(30, 30)).toBe(false);
  });

  it("skips duplicate ticker writes inside the epsilon window", () => {
    expect(shouldWritePosition(30, 30.1)).toBe(false);
  });

  it("writes normal playback progress between ticks", () => {
    // The progress ticker runs every 500ms, comfortably past the guard.
    expect(shouldWritePosition(30, 30.5)).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(shouldWritePosition(30, Number.NaN)).toBe(false);
    expect(shouldWritePosition(30, -1)).toBe(false);
  });

  it("keeps the original timestamp when a duplicate event is applied twice", () => {
    // Simulates writePosition: only a real change restamps the action time.
    const positions: Record<string, number> = {};
    const times: Record<string, number> = {};
    const apply = (key: string, seconds: number, at: number) => {
      if (!shouldWritePosition(positions[key], seconds)) return;
      positions[key] = seconds;
      times[key] = at;
    };

    apply("a", 60, 1_000);
    apply("a", 60, 2_000); // duplicate event from the same device
    apply("a", 60.1, 3_000); // jitter

    expect(positions["a"]).toBe(60);
    expect(times["a"]).toBe(1_000);

    apply("a", 75, 4_000);
    expect(positions["a"]).toBe(75);
    expect(times["a"]).toBe(4_000);
  });
});
