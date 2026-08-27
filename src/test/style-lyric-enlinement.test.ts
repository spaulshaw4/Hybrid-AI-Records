import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { StyleLyricEnlinement } from "@/lib/StyleLyricEnlinement";

describe("StyleLyricEnlinement", () => {
  it("maps valence and density to vocal presets and drive", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_lyric", requestId: "req_lyric_1" },
    );

    const result = StyleLyricEnlinement.enlineLyricsWithStyle(ctx, [
      {
        sectionName: "VERSE",
        lyricSnippet: "I think in quiet rooms",
        emotionalValence: "INTROSPECTIVE",
        syllableDensityPerBar: 5,
      },
      {
        sectionName: "CHORUS",
        lyricSnippet: "We rise and win the light",
        emotionalValence: "TRIUMPHANT",
        syllableDensityPerBar: 8,
      },
      {
        sectionName: "BRIDGE",
        lyricSnippet: "Break the fire rage war",
        emotionalValence: "AGGRESSIVE",
        syllableDensityPerBar: 14,
      },
    ]);

    expect(result.lyricBlueprintId).toMatch(/^lyric_enline_nonce_lyric_/);
    expect(result.lyricStyleCoherenceScore).toBeGreaterThanOrEqual(0.92);
    expect(result.lyricStyleCoherenceScore).toBeLessThanOrEqual(1);

    const bySection = Object.fromEntries(
      result.synchronizedArrangementProfiles.map((p) => [p.section, p]),
    );
    expect(bySection.VERSE.vocalProcessingPreset).toBe("intimate_dry_close_mic");
    expect(bySection.VERSE.instrumentationDensity).toBe("STRIPPED");
    expect(bySection.CHORUS.vocalProcessingPreset).toBe("wide_stereo_doubled_chorus");
    expect(bySection.BRIDGE.instrumentationDensity).toBe("WALL_OF_SOUND");
    expect(bySection.BRIDGE.transientDrive).toBeGreaterThan(0.8);
  });

  it("is deterministic for the same CTX + segments", () => {
    const mk = () =>
      ContextFactory.create(
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "enterprise",
        "aligned-runner",
        { sessionNonce: "nonce_det_ly", requestId: "req_det_ly" },
      );
    const segments = [
      {
        sectionName: "VERSE" as const,
        lyricSnippet: "hello",
        emotionalValence: "MELANCHOLIC" as const,
        syllableDensityPerBar: 4,
      },
    ];
    const a = StyleLyricEnlinement.enlineLyricsWithStyle(mk(), segments);
    const b = StyleLyricEnlinement.enlineLyricsWithStyle(mk(), segments);
    expect(a.lyricStyleCoherenceScore).toBe(b.lyricStyleCoherenceScore);
  });

  it("derives segments from free-text lyrics", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "cortex-worker",
      { requestId: "req_derive_ly", sessionNonce: "nonce_derive_ly" },
    );
    const segments = StyleLyricEnlinement.deriveSegmentsFromStudioPayload({
      ctx,
      lyrics: "I fight the fire\n\nWe rise and win",
      genreHint: "nu metal",
    });
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(segments[0].sectionName).toBe("VERSE");
    expect(segments.some((s) => s.emotionalValence === "AGGRESSIVE" || s.emotionalValence === "TRIUMPHANT")).toBe(
      true,
    );
  });

  it("is wired after genre entitlement and before dismantel", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const genreIdx = source.indexOf("GenreEntitlementPlacement.verifyAndEnforceEntitlement");
    const lyricIdx = source.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    const disIdx = source.indexOf("IntuitiveDismantelPlacement.executeDismantelPlacement");
    expect(genreIdx).toBeGreaterThan(-1);
    expect(lyricIdx).toBeGreaterThan(genreIdx);
    expect(disIdx).toBeGreaterThan(lyricIdx);
    expect(source).toContain("styleLyricEnlinement");
  });
});
