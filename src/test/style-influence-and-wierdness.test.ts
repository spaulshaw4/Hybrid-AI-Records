import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { StyleInfluenceEnlightment } from "@/lib/StyleInfluenceEnlightment";
import { WierdnessEnlinement } from "@/lib/WierdnessEnlinement";

describe("StyleInfluenceEnlightment", () => {
  it("maps Seattle archetype into saturation / reverb signatures", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_inf", requestId: "req_inf_1" },
    );
    const blueprint = StyleInfluenceEnlightment.enlighteneStyleInfluence(
      ctx,
      "SEATTLE_90S_WALL_OF_SOUND",
    );
    expect(blueprint.influenceBlueprintId).toMatch(/^influence_nonce_inf_/);
    expect(blueprint.sonicSignatures.midRangeBoxinessCutDb).toBe(-2.5);
    expect(blueprint.sonicSignatures.harmonicTubeSaturationLevel).toBe(6.8);
    expect(blueprint.enlightmentCoherenceScore).toBeGreaterThanOrEqual(0.95);
  });

  it("resolves archetypes from genre / text hints", () => {
    expect(
      StyleInfluenceEnlightment.resolveArchetype({ genre: "NU_METAL" }),
    ).toBe("MODERN_TRAP_METAL_HYBRID");
    expect(
      StyleInfluenceEnlightment.resolveArchetype({
        styleHint: "british post-punk",
      }),
    ).toBe("BRITISH_POST_PUNK_TENSE");
    expect(
      StyleInfluenceEnlightment.resolveArchetype({
        genre: "RAP_ROCK",
        promptHint: "detroit industrial",
      }),
    ).toBe("DETROIT_INDUSTRIAL_GRIT");
  });

  it("is deterministic for the same CTX + archetype", () => {
    const mk = () =>
      ContextFactory.create(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "enterprise",
        "aligned-runner",
        { sessionNonce: "nonce_det_inf", requestId: "req_det_inf" },
      );
    const a = StyleInfluenceEnlightment.enlighteneStyleInfluence(
      mk(),
      "DETROIT_INDUSTRIAL_GRIT",
    );
    const b = StyleInfluenceEnlightment.enlighteneStyleInfluence(
      mk(),
      "DETROIT_INDUSTRIAL_GRIT",
    );
    expect(a.enlightmentCoherenceScore).toBe(b.enlightmentCoherenceScore);
  });
});

describe("WierdnessEnlinement", () => {
  it("scales anomalies from chaos factor and sets verdict bands", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_wierd" },
    );
    const subtle = WierdnessEnlinement.enlineWierdness(ctx, {
      chaosFactor: 0.2,
      targetElement: "MASTER_BUS",
    });
    expect(subtle.wierdnessVerdict).toBe("SUBTLE_CHARACTER");
    expect(subtle.anomalyParameters.microPitchDetuneCents).toBeGreaterThan(0);

    const radical = WierdnessEnlinement.enlineWierdness(ctx, {
      chaosFactor: 0.85,
      targetElement: "GUITAR_TRANSIENTS",
    });
    expect(radical.wierdnessVerdict).toBe("RADICAL_ALTERATION");
  });

  it("resolves chaos from weirdness 0-100 controls", () => {
    expect(WierdnessEnlinement.resolveChaosFactor({ weirdness: 50 })).toBe(0.5);
    expect(WierdnessEnlinement.resolveChaosFactor({ weirdness: 0.4 })).toBe(0.4);
  });
});

describe("influence + wierdness worker wiring", () => {
  it("orders genre → influence → bpm → lyric → wierdness", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const genreIdx = source.indexOf("GenreEntitlementPlacement.verifyAndEnforceEntitlement");
    const infIdx = source.indexOf("StyleInfluenceEnlightment.enlighteneStyleInfluence");
    const bpmIdx = source.indexOf("BpmEnlinement.enlineBpmGrid");
    const lyricIdx = source.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    const wierdIdx = source.indexOf("WierdnessEnlinement.enlineWierdness");
    expect(genreIdx).toBeGreaterThan(-1);
    expect(infIdx).toBeGreaterThan(genreIdx);
    expect(bpmIdx).toBeGreaterThan(infIdx);
    expect(lyricIdx).toBeGreaterThan(bpmIdx);
    expect(wierdIdx).toBeGreaterThan(lyricIdx);
    expect(source).toContain("styleInfluenceEnlightment");
    expect(source).toContain("wierdnessEnlinement");
  });
});
