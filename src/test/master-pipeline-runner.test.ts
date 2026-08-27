import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DetanglementReactor } from "@/lib/DetanglementReactor";
import { PipelineInformant } from "@/lib/PipelineInformant";
import { MasterPipelineRunner } from "@/lib/MasterPipelineRunner";

describe("MasterPipelineRunner", () => {
  beforeEach(() => {
    process.env.PIPELINE_MASTER_STATE = "ARMED";
    process.env.MAX_QUEUE_CAPACITY = "100";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PIPELINE_MASTER_STATE;
    delete process.env.MAX_QUEUE_CAPACITY;
  });

  it("returns MASTER_PIPELINE_SUCCESS with full blueprints", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();
    vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: (table: string) => {
        if (table === "generation_queue") {
          return {
            select: () => ({
              eq: (_c: string, val: string) => {
                if (val === "pending") return Promise.resolve({ count: 0, error: null });
                return {
                  gte: async () => ({ count: 0, error: null }),
                  eq: async () => ({ count: 0, error: null }),
                };
              },
            }),
          };
        }
        return { insert: async () => ({ error: null }) };
      },
    } as never);

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: {
        prompt: "seattle wall of sound anthem",
        title: "Master Track",
        genre: "heavy alternative rock",
        lyrics: "I think in quiet rooms\n\nWe rise and win",
        durationSeconds: 180,
        controls: { bpm: 120 },
      },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_master",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const result = await MasterPipelineRunner.executeMasterPipeline({
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      tier: "pro",
      genreArchetype: "SEATTLE_90S_WALL_OF_SOUND",
      masterBpm: 120,
      lyricSegments: [],
      chaosFactor: 0.4,
      recordedVocalTakes: [
        {
          takeId: "take_1",
          artistName: "Hybrid",
          audioDurationSeconds: 16,
          detectedBpm: 120,
          intendedSection: "CHORUS",
          transientOffsetsMs: [0, 500, 1000],
        },
      ],
      rawPayload: {
        prompt: "seattle wall of sound anthem",
        genre: "heavy alternative rock",
        lyrics: "We rise and win",
      },
    });

    expect(result.status).toBe("MASTER_PIPELINE_SUCCESS");
    if (result.status === "MASTER_PIPELINE_SUCCESS") {
      expect(result.settlement.settlementId).toMatch(/^settle_/);
      expect(result.blueprints.influenceBlueprint.archetype).toBe(
        "SEATTLE_90S_WALL_OF_SOUND",
      );
      expect(result.blueprints.bpmBlueprint.masterBpm).toBe(120);
      expect(result.blueprints.rhythmBlueprint.accentPositions).toEqual([2, 4]);
      expect(result.blueprints.rhythmBlueprint.swingFactor).toBe(0.096);
      expect(result.blueprints.theoryBlueprint.tonicNote).toBe("E");
      expect(result.blueprints.theoryBlueprint.mode).toBe("AEOLIAN");
      expect(result.blueprints.theoryBlueprint.diatonicTriads).toHaveLength(7);
      expect(result.blueprints.philosophyBlueprint.enforcedComplianceNorm).toBe(
        "RECORDING_AS_WORK_INSTANCE",
      );
      expect(result.blueprints.philosophyBlueprint.structuralCoherenceVerdict).toBe(
        "ONTOLOGICALLY_STABLE",
      );
      expect(result.blueprints.vocalAlignmentResults.length).toBe(1);
      expect(result.blueprints.vocalBalanceBlueprint.instrumentalMidCarveHz).toBe(1400);
      expect(result.blueprints.vocalBalanceBlueprint.masterpieceCoherenceIndex).toBeGreaterThanOrEqual(
        0.965,
      );
      expect(result.blueprints.wierdnessBlueprint.wierdnessVerdict).toBe(
        "EXPERIMENTAL_DRIFT",
      );
      expect(result.blueprints.decompression.peakLimitingCeilingDb).toBe(-0.3);
      expect(result.providerPayload.metadataStamps.requestId).toBeTruthy();
    }
  });

  it("grounds genre BPM mismatch as MASTER_PIPELINE_GROUNDED_FAULT", async () => {
    const { PipelineActivatorSwitch } = await import("@/lib/PipelineActivatorSwitch");
    PipelineActivatorSwitch.bustCache();
    vi.spyOn(PipelineInformant, "recordTelemetry").mockResolvedValue();

    vi.spyOn(
      await import("@/integrations/supabase/client.server"),
      "tryGetSupabaseAdmin",
    ).mockReturnValue({
      from: () => ({
        select: () => ({
          eq: () => Promise.resolve({ count: 0, error: null }),
        }),
      }),
    } as never);

    vi.spyOn(DetanglementReactor, "purgeCrossCorrelations").mockReturnValue({
      sanitizedPayload: { prompt: "amapiano", genre: "amapiano" },
      reactorState: {
        entanglementLevel: 0.02,
        suppressionActive: true,
        reactorNonce: "reactor_q",
        entropyScore: 0.2,
        aggressiveDampening: false,
      },
    });

    const result = await MasterPipelineRunner.executeMasterPipeline({
      userId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      tier: "pro",
      genreArchetype: "MODERN_TRAP_METAL_HYBRID",
      masterBpm: 160,
      lyricSegments: [],
      chaosFactor: 0.2,
      supportedGenreHint: "amapiano",
      rawPayload: { prompt: "amapiano", genre: "amapiano" },
    });

    expect(result.status).toBe("MASTER_PIPELINE_GROUNDED_FAULT");
    if (result.status === "MASTER_PIPELINE_GROUNDED_FAULT") {
      expect(result.groundReference).toMatch(/^ground_drain_/);
      expect(result.faultSource).toBe("QUARANTINE_NODE");
    }
  });

  it("ships as the fully integrated master composer", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/MasterPipelineRunner.ts"),
      "utf8",
    );
    expect(source).toContain("StyleInfluenceEnlightment");
    expect(source).toContain("BpmEnlinement");
    expect(source).toContain("LogicalRhythmEnlinement");
    expect(source).toContain("ClassicalTheoryEngine");
    expect(source).toContain("MusicalOntologyAndLogicEngine");
    expect(source).toContain("RecordedVoiceStructureEnlinement");
    expect(source).toContain("AlgorithmicVocalBalance");
    expect(source).toContain("WierdnessEnlinement");
    expect(source).toContain("IntuitiveDismantelPlacement");
    expect(source).toContain("MusicStructureInlining");
    expect(source).toContain("DecompressionEnlinement");
    expect(source).toContain("LedgerSettlementGate");
    expect(source).toContain("MASTER_PIPELINE_SUCCESS");
  });
});
