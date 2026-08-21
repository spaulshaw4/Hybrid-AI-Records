import { describe, it, expect } from "vitest";
import { settingsSchema } from "@/lib/radio-sync.functions";

const base = {
  mixStyle: "artist" as const,
  shuffle: false,
  spacing: 2,
  mixSeed: 42,
  trackKey: null,
  queue: [],
  positions: {},
};

const parse = (clientUpdatedAt?: string) =>
  settingsSchema.parse({ ...base, ...(clientUpdatedAt === undefined ? {} : { clientUpdatedAt }) });

describe("radio settings clientUpdatedAt", () => {
  it("accepts an omitted timestamp", () => {
    expect(parse().clientUpdatedAt).toBeUndefined();
  });

  it.each([
    ["UTC Z form", "2026-08-11T06:39:00.000Z", "2026-08-11T06:39:00.000Z"],
    ["seconds precision", "2026-08-11T06:39:00Z", "2026-08-11T06:39:00.000Z"],
    ["positive offset", "2026-08-11T09:39:00+03:00", "2026-08-11T06:39:00.000Z"],
    ["negative offset", "2026-08-11T01:39:00-05:00", "2026-08-11T06:39:00.000Z"],
  ])("normalizes %s to ISO UTC", (_label, input, expected) => {
    expect(parse(input).clientUpdatedAt).toBe(expected);
  });

  it.each([
    ["empty string", ""],
    ["free text", "not a date"],
    ["impossible month", "2026-13-45T00:00:00Z"],
    ["partial garbage", "2026-08-11T99:99:99Z"],
  ])("rejects %s", (_label, input) => {
    expect(() => parse(input)).toThrow();
  });

  it("rejects a non-string timestamp", () => {
    expect(() => settingsSchema.parse({ ...base, clientUpdatedAt: 1754894340000 })).toThrow();
  });
});
