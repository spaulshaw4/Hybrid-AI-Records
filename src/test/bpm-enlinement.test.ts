import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { BpmEnlinement } from "@/lib/BpmEnlinement";

describe("BpmEnlinement", () => {
  it("builds a precise timing grid from master BPM", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_bpm", requestId: "req_bpm_1" },
    );

    const grid = BpmEnlinement.enlineBpmGrid(ctx, {
      masterBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
    });

    expect(grid.bpmBlueprintId).toMatch(/^bpm_enline_nonce_bpm_/);
    expect(grid.masterBpm).toBe(120);
    expect(grid.beatDurationMs).toBe(500);
    expect(grid.barDurationMs).toBe(2000);
    expect(grid.sixteenthNoteMs).toBe(125);
    expect(grid.syncedDelayTimes.quarterNoteMs).toBe(500);
    expect(grid.syncedDelayTimes.dottedEighthMs).toBe(375);
    expect(grid.syncedDelayTimes.halfNoteMs).toBe(1000);
    expect(grid.sidechainReleaseMs).toBe(250);
  });

  it("scales beat length for non-4/4 denominators", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "aligned-runner",
      { sessionNonce: "nonce_68" },
    );
    const grid = BpmEnlinement.enlineBpmGrid(ctx, {
      masterBpm: 120,
      timeSignatureNumerator: 6,
      timeSignatureDenominator: 8,
    });
    // Eighth-note beat at 120 BPM = 250ms; 6 beats/bar = 1500ms
    expect(grid.beatDurationMs).toBe(250);
    expect(grid.barDurationMs).toBe(1500);
  });

  it("is wired after genre entitlement and before lyric enlinement", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const genreIdx = source.indexOf("GenreEntitlementPlacement.verifyAndEnforceEntitlement");
    const bpmIdx = source.indexOf("BpmEnlinement.enlineBpmGrid");
    const lyricIdx = source.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    expect(genreIdx).toBeGreaterThan(-1);
    expect(bpmIdx).toBeGreaterThan(genreIdx);
    expect(lyricIdx).toBeGreaterThan(bpmIdx);
    expect(source).toContain("bpmEnlinement");
  });
});
