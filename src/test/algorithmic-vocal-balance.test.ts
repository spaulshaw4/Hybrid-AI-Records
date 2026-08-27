import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { AlgorithmicVocalBalance } from "@/lib/AlgorithmicVocalBalance";
import { StyleLyricEnlinement } from "@/lib/StyleLyricEnlinement";

describe("AlgorithmicVocalBalance", () => {
  it("carves mid pocket and scales ducking with emotional intensity", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_vb", requestId: "req_vb_1" },
    );

    const soft = AlgorithmicVocalBalance.balanceVocals(ctx, {
      vocalPeakRmsDb: -8,
      vocalFundamentalHz: 1000,
      emotionalIntensity: 0.2,
    });
    const hard = AlgorithmicVocalBalance.balanceVocals(ctx, {
      vocalPeakRmsDb: -4,
      vocalFundamentalHz: 1400,
      emotionalIntensity: 0.9,
    });

    expect(soft.balanceBlueprintId).toMatch(/^vocal_balance_nonce_vb_/);
    expect(soft.instrumentalMidCarveHz).toBe(1000);
    expect(soft.dynamicSidechainDuckingDb).toBe(-3.2);
    expect(soft.instrumentalMidCarveDepthDb).toBe(-3.4);
    expect(soft.harmonicBlendRatio).toBe(0.794);

    expect(hard.instrumentalMidCarveHz).toBe(1400);
    expect(hard.dynamicSidechainDuckingDb).toBe(-5.65);
    expect(hard.instrumentalMidCarveDepthDb).toBe(-4.8);
    expect(hard.harmonicBlendRatio).toBe(0.948);
    expect(hard.masterpieceCoherenceIndex).toBeGreaterThanOrEqual(0.965);
    expect(hard.masterpieceCoherenceIndex).toBeLessThanOrEqual(0.999);
  });

  it("uses CTX-seeded coherence (deterministic, no Math.random)", () => {
    const a = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same", requestId: "req_same" },
    );
    const b = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same", requestId: "req_same" },
    );

    const input = {
      vocalPeakRmsDb: -6,
      vocalFundamentalHz: 1200,
      emotionalIntensity: 0.6,
    };
    expect(AlgorithmicVocalBalance.balanceVocals(a, input).masterpieceCoherenceIndex).toBe(
      AlgorithmicVocalBalance.balanceVocals(b, input).masterpieceCoherenceIndex,
    );

    const source = readFileSync(
      join(process.cwd(), "src/lib/AlgorithmicVocalBalance.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).toContain("algorithmicHash32");
  });

  it("derives inputs from lyric drive and chorus vocal routing", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "aligned-runner",
      { sessionNonce: "nonce_derive_vb", requestId: "req_derive_vb" },
    );
    const lyrics = StyleLyricEnlinement.enlineLyricsWithStyle(ctx, [
      {
        sectionName: "CHORUS",
        lyricSnippet: "We rise and win",
        emotionalValence: "AGGRESSIVE",
        syllableDensityPerBar: 14,
      },
    ]);
    const derived = AlgorithmicVocalBalance.deriveVocalBalanceInput({
      lyricEnlinement: lyrics,
      vocalAlignments: [
        {
          alignmentBlueprintId: "x",
          takeId: "t1",
          targetSection: "CHORUS",
          gridSnapOffsetMs: 0,
          structuralFitVerdict: "PERFECT_GRID_FIT",
          assignedBusRouting: "chorus_stadium_wide_vocal_bus",
          bpmVariance: 0,
          masterBpm: 120,
        },
      ],
    });

    expect(derived.vocalFundamentalHz).toBe(1400);
    expect(derived.emotionalIntensity).toBeGreaterThanOrEqual(0.85);
  });

  it("is wired after recorded voice / lyric and before wierdness", () => {
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const master = readFileSync(
      join(process.cwd(), "src/lib/MasterPipelineRunner.ts"),
      "utf8",
    );
    const lyricIdx = worker.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    const balanceIdx = worker.indexOf("AlgorithmicVocalBalance.balanceVocals");
    const wierdIdx = worker.indexOf("WierdnessEnlinement.enlineWierdness");
    expect(balanceIdx).toBeGreaterThan(lyricIdx);
    expect(wierdIdx).toBeGreaterThan(balanceIdx);
    expect(worker).toContain("algorithmicVocalBalance");
    expect(master).toContain("AlgorithmicVocalBalance");
    expect(master).toContain("vocalBalanceBlueprint");
  });
});
