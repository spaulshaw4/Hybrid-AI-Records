import { describe, expect, it } from "vitest";
import { resolvePositions, type PositionState } from "@/lib/radio-positions";

const T = "trk-1::Blooms Into Madness";
const T2 = "trk-2::What I Told The Fire";

const NOW = 1_770_000_000_000;

function state(positions: Record<string, number>, positionTimes: Record<string, number>): PositionState {
  return { positions, positionTimes };
}

describe("cross-device resume-point resolution", () => {
  it("accepts a remote seek that happened after the local one", () => {
    const local = state({ [T]: 30 }, { [T]: NOW - 10_000 });
    const result = resolvePositions(local, { positions: { [T]: 120 }, positionTimes: { [T]: NOW } });

    expect(result.positions[T]).toBe(120);
    expect(result.changed).toBe(1);
    expect(result.resolved[0]).toMatchObject({ key: T, seconds: 120, wonAt: NOW });
  });

  it("rejects an out-of-order remote seek that is older than the local one", () => {
    const local = state({ [T]: 120 }, { [T]: NOW });
    // Payload arrives late but describes an earlier action on another device.
    const result = resolvePositions(local, { positions: { [T]: 30 }, positionTimes: { [T]: NOW - 60_000 } });

    expect(result.positions[T]).toBe(120);
    expect(result.positionTimes[T]).toBe(NOW);
    expect(result.changed).toBe(0);
    expect(result.resolved).toEqual([]);
  });

  it("keeps the newest action no matter what order payloads arrive in", () => {
    const deviceA = { positions: { [T]: 45 }, positionTimes: { [T]: NOW - 30_000 } };
    const deviceB = { positions: { [T]: 200 }, positionTimes: { [T]: NOW } };
    const empty = state({}, {});

    const inOrder = resolvePositions(resolvePositions(empty, deviceA), deviceB);
    const reversed = resolvePositions(resolvePositions(empty, deviceB), deviceA);

    expect(inOrder.positions[T]).toBe(200);
    expect(reversed.positions[T]).toBe(200);
    expect(reversed.positionTimes[T]).toBe(NOW);
  });

  it("is idempotent when the same payload is replayed", () => {
    const remote = { positions: { [T]: 88 }, positionTimes: { [T]: NOW } };
    const first = resolvePositions(state({}, {}), remote);
    const second = resolvePositions(first, remote);

    expect(second.positions[T]).toBe(88);
    expect(second.changed).toBe(0);
  });

  it("treats an untimestamped remote entry as older than a timestamped local one", () => {
    const local = state({ [T]: 75 }, { [T]: NOW });
    const result = resolvePositions(local, { positions: { [T]: 5 } });

    expect(result.positions[T]).toBe(75);
    expect(result.changed).toBe(0);
  });

  it("adopts a remote track this device has never played", () => {
    const result = resolvePositions(state({}, {}), {
      positions: { [T2]: 12.4 },
      positionTimes: { [T2]: NOW - 1 },
    });

    expect(result.positions[T2]).toBe(12.4);
    expect(result.changed).toBe(1);
  });

  it("resolves each track independently in a mixed payload", () => {
    const local = state({ [T]: 120, [T2]: 10 }, { [T]: NOW, [T2]: NOW - 90_000 });
    const result = resolvePositions(local, {
      positions: { [T]: 3, [T2]: 240 },
      positionTimes: { [T]: NOW - 5_000, [T2]: NOW - 1_000 },
    });

    expect(result.positions[T]).toBe(120); // local newer, stale remote rejected
    expect(result.positions[T2]).toBe(240); // remote newer, wins
    expect(result.changed).toBe(1);
    expect(result.resolved.map((r) => r.key)).toEqual([T2]);
  });

  it("keeps the local value on a timestamp tie", () => {
    const local = state({ [T]: 60 }, { [T]: NOW });
    const result = resolvePositions(local, { positions: { [T]: 61 }, positionTimes: { [T]: NOW } });

    expect(result.positions[T]).toBe(60);
    expect(result.changed).toBe(0);
  });

  it("honours a newer remote 'cleared' marker over an older local resume point", () => {
    const local = state({ [T]: 150 }, { [T]: NOW - 20_000 });
    const result = resolvePositions(local, { positions: { [T]: 0 }, positionTimes: { [T]: NOW } });

    expect(result.positions[T]).toBe(0);
    expect(result.changed).toBe(1);
  });

  it("does not mutate the local state it was given", () => {
    const positions = { [T]: 30 };
    const positionTimes = { [T]: NOW - 1_000 };
    resolvePositions({ positions, positionTimes }, { positions: { [T]: 90 }, positionTimes: { [T]: NOW } });

    expect(positions[T]).toBe(30);
    expect(positionTimes[T]).toBe(NOW - 1_000);
  });
});
