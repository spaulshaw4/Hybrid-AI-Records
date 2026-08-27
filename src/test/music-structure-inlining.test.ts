import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { IntuitiveDismantelPlacement } from "@/lib/IntuitiveDismantelPlacement";
import { MusicStructureInlining } from "@/lib/MusicStructureInlining";

describe("MusicStructureInlining", () => {
  it("inlines contiguous bars with section-aware transitions", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_inline", requestId: "req_inline_1" },
    );

    const result = MusicStructureInlining.inlineArrangementStructure(ctx, [
      { sectionName: "INTRO", barCount: 4, activeStems: ["drums", "bass"] },
      { sectionName: "VERSE", barCount: 8, activeStems: ["drums", "bass", "harmony"] },
      { sectionName: "CHORUS", barCount: 8, activeStems: ["drums", "bass", "harmony", "lead"] },
      { sectionName: "BRIDGE", barCount: 4, activeStems: ["harmony", "fx"] },
      { sectionName: "OUTRO", barCount: 4, activeStems: ["bass"] },
    ]);

    expect(result.timelineBlueprintId).toMatch(/^inline_timeline_nonce_inline_/);
    expect(result.totalBars).toBe(28);
    expect(result.inlinedArrangementMap[0]).toMatchObject({
      section: "INTRO",
      startBar: 1,
      endBar: 4,
      transitionType: "FILTRATION_RISE",
    });
    expect(result.inlinedArrangementMap[2]).toMatchObject({
      section: "CHORUS",
      startBar: 13,
      endBar: 20,
      transitionType: "SWEEP_DROP",
    });
    expect(result.inlinedArrangementMap[3].transitionType).toBe("FILTRATION_RISE");
    expect(result.inlinedArrangementMap[4].transitionType).toBe("HARD_CUT");
  });

  it("derives blocks from dismantel stems and inlines without gaps", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "aligned-runner",
      { sessionNonce: "nonce_derive_inline", requestId: "req_derive_inline" },
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

    expect(blocks.map((b) => b.sectionName)).toEqual([
      "INTRO",
      "VERSE",
      "CHORUS",
      "BRIDGE",
      "OUTRO",
    ]);
    expect(inlined.totalBars).toBeGreaterThan(0);
    // Contiguous: each segment starts where previous ended + 1
    for (let i = 1; i < inlined.inlinedArrangementMap.length; i += 1) {
      const prev = inlined.inlinedArrangementMap[i - 1];
      const cur = inlined.inlinedArrangementMap[i];
      expect(cur.startBar).toBe(prev.endBar + 1);
    }
  });

  it("is wired after dismantel and before End-Gate in the worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const disIdx = source.indexOf("IntuitiveDismantelPlacement.executeDismantelPlacement");
    const inlineIdx = source.indexOf("MusicStructureInlining.inlineArrangementStructure");
    const endIdx = source.indexOf("EndGateDispatcher.deliverToUserVault");
    expect(disIdx).toBeGreaterThan(-1);
    expect(inlineIdx).toBeGreaterThan(disIdx);
    expect(endIdx).toBeGreaterThan(inlineIdx);
    expect(source).toContain("musicStructureInlining");
  });
});
