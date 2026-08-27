import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { IntuitiveDismantelPlacement } from "@/lib/IntuitiveDismantelPlacement";
import { MusicStructureInlining } from "@/lib/MusicStructureInlining";
import { DecompressionEnlinement } from "@/lib/DecompressionEnlinement";

describe("DecompressionEnlinement", () => {
  it("applies section-aware curves and -0.3 dB peak ceiling", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_decomp", requestId: "req_decomp_1" },
    );

    const result = DecompressionEnlinement.executeDecompressionEnlinement(ctx, [
      { sectionName: "INTRO", targetLufs: -14, transientPunchRatio: 0.3 },
      { sectionName: "VERSE", targetLufs: -14, transientPunchRatio: 0.45 },
      { sectionName: "CHORUS", targetLufs: -9, transientPunchRatio: 0.85 },
      { sectionName: "BRIDGE", targetLufs: -10, transientPunchRatio: 0.7 },
      { sectionName: "OUTRO", targetLufs: -14, transientPunchRatio: 0.25 },
    ]);

    expect(result.masteringBlueprintId).toMatch(/^decompression_nonce_decomp_/);
    expect(result.peakLimitingCeilingDb).toBe(-0.3);

    const byName = Object.fromEntries(
      result.appliedDynamicProfiles.map((p) => [p.sectionName, p]),
    );
    expect(byName.CHORUS.decompressionCurve).toBe("EXPONENTIAL");
    expect(byName.BRIDGE.decompressionCurve).toBe("EXPONENTIAL");
    expect(byName.INTRO.decompressionCurve).toBe("LOGARITHMIC");
    expect(byName.OUTRO.decompressionCurve).toBe("LOGARITHMIC");
    expect(byName.VERSE.decompressionCurve).toBe("LINEAR");
    expect(byName.CHORUS.makeupGainDb).toBeGreaterThan(byName.INTRO.makeupGainDb);
  });

  it("derives dynamics from inlined structure and locks the full music chain", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "aligned-runner",
      { sessionNonce: "nonce_chain", requestId: "req_chain" },
    );
    const stems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
      ctx,
      hasMaster: true,
      hasInstrumental: true,
      hasVocal: true,
    });
    const dismantel = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, stems);
    const blocks = MusicStructureInlining.deriveBlocksFromDismantel(ctx, dismantel);
    const inlined = MusicStructureInlining.inlineArrangementStructure(ctx, blocks);
    const dynamics = DecompressionEnlinement.deriveSectionDynamicsFromInline(ctx, inlined);
    const decomp = DecompressionEnlinement.executeDecompressionEnlinement(ctx, dynamics);

    expect(dynamics.length).toBe(inlined.inlinedArrangementMap.length);
    expect(decomp.appliedDynamicProfiles.length).toBe(dynamics.length);
    expect(decomp.peakLimitingCeilingDb).toBe(-0.3);
  });

  it("is wired after structure inlining and before End-Gate", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const inlineIdx = source.indexOf("MusicStructureInlining.inlineArrangementStructure");
    const decompIdx = source.indexOf("DecompressionEnlinement.executeDecompressionEnlinement");
    const endIdx = source.indexOf("EndGateDispatcher.deliverToUserVault");
    expect(inlineIdx).toBeGreaterThan(-1);
    expect(decompIdx).toBeGreaterThan(inlineIdx);
    expect(endIdx).toBeGreaterThan(decompIdx);
    expect(source).toContain("decompressionEnlinement");
  });
});
