#!/usr/bin/env node
/**
 * Master Pipeline live-payload verification (20/20 node chain).
 *
 * Exercises MasterPipelineRunner end-to-end with a complete studio payload —
 * genre, BPM, logical rhythm, classical theory, musical ontology, lyrics,
 * recorded vocals, vocal balance, wierdness, dismantel/structure/decompression,
 * and ledger settlement — asserting zero exceptions.
 *
 * Usage:
 *   npm run verify:master-pipeline
 *   npx tsx scripts/verifyMasterPipeline.ts
 *
 * Env:
 *   PIPELINE_MASTER_STATE=ARMED   (defaulted by this script)
 *   VERIFY_MASTER_LIVE=1          use real Supabase admin probes (no stubs)
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.production" });
dotenv.config({ path: ".env" });

process.env.PIPELINE_MASTER_STATE = process.env.PIPELINE_MASTER_STATE || "ARMED";
process.env.MAX_QUEUE_CAPACITY = process.env.MAX_QUEUE_CAPACITY || "100";

async function installVerificationStubs() {
  if (process.env.VERIFY_MASTER_LIVE === "1") {
    console.log("[VERIFICATION] LIVE mode — using real Supabase probes.");
    return;
  }

  const { PipelineInformant } = await import("../src/lib/PipelineInformant");
  const originalRecord = PipelineInformant.recordTelemetry.bind(PipelineInformant);
  PipelineInformant.recordTelemetry = async (...args: Parameters<typeof originalRecord>) => {
    try {
      await originalRecord(...args);
    } catch {
      /* verification must not fail on telemetry I/O */
    }
  };

  const supabaseMod = await import("../src/integrations/supabase/client.server");
  const originalTryGet = supabaseMod.tryGetSupabaseAdmin;
  if (!originalTryGet()) {
    console.log(
      "[VERIFICATION] No Supabase service role — installing offline flow probes.",
    );
    (supabaseMod as { tryGetSupabaseAdmin: typeof originalTryGet }).tryGetSupabaseAdmin = () =>
      ({
        from: (table: string) => {
          if (table === "generation_queue") {
            return {
              select: () => ({
                eq: (_c: string, val: string) => {
                  if (val === "pending") {
                    return Promise.resolve({ count: 0, error: null });
                  }
                  return {
                    gte: async () => ({ count: 0, error: null }),
                    eq: async () => ({ count: 0, error: null }),
                  };
                },
                gte: async () => ({ count: 0, error: null }),
              }),
            };
          }
          if (table === "system_config") {
            return {
              select: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { value: "ARMED" },
                    error: null,
                  }),
                }),
              }),
            };
          }
          return {
            insert: async () => ({ error: null }),
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          };
        },
      }) as ReturnType<typeof originalTryGet>;
  } else {
    console.log("[VERIFICATION] Supabase service role detected — using live probes.");
  }

  const { PipelineActivatorSwitch } = await import("../src/lib/PipelineActivatorSwitch");
  PipelineActivatorSwitch.bustCache();
}

async function runFullPipelineVerification() {
  console.log(
    "[VERIFICATION START] Initializing MasterPipelineRunner with 20/20 Node Chain...",
  );

  await installVerificationStubs();

  const { MasterPipelineRunner } = await import("../src/lib/MasterPipelineRunner");
  type MasterPipelineInput = import("../src/lib/MasterPipelineRunner").MasterPipelineInput;

  const testPayload: MasterPipelineInput = {
    // UUID required for flux coating / Informant
    userId: "a1b2c3d4-e5f6-4789-a012-3456789abcde",
    tier: "enterprise",
    genreArchetype: "SEATTLE_90S_WALL_OF_SOUND",
    masterBpm: 120,
    tonicNote: "C",
    scaleMode: "IONIAN",
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    syncopationThreshold: 0.42,
    workOntologyType: "THICK_CLASSICAL_SCORE",
    listeningMode: "ARCHITECTONIC_LARGE_SCALE",
    expressiveValence: "TRAGIC_SADNESS",
    lyricSegments: [
      {
        sectionName: "VERSE",
        lyricSnippet: "Walking down the neon corridor, searching for the circuit spark",
        emotionalValence: "INTROSPECTIVE",
        syllableDensityPerBar: 8,
      },
      {
        sectionName: "CHORUS",
        lyricSnippet: "Heavy sky arrival! Breaking through the silent dark!",
        emotionalValence: "AGGRESSIVE",
        syllableDensityPerBar: 14,
      },
    ],
    recordedVocalTakes: [
      {
        takeId: "vocal_take_001_raw",
        artistName: "Stephen Paul Shaw",
        audioDurationSeconds: 180,
        detectedBpm: 119.8,
        intendedSection: "VERSE",
        transientOffsetsMs: [120, 2150, 4100, 6050],
      },
    ],
    chaosFactor: 0.42,
    rawPayload: {
      prompt: "Heavy alternative rock hybrid anthem with classical deterministic grounding",
      genre: "heavy alternative rock",
      trackConcept:
        "Heavy alternative rock hybrid anthem with classical deterministic grounding",
      targetMixProfile: "analog_console_emulation",
      lyrics:
        "Walking down the neon corridor, searching for the circuit spark\n\nHeavy sky arrival! Breaking through the silent dark!",
      durationSeconds: 180,
      controls: { bpm: 120, weirdness: 0.42, syncopation: 0.42 },
      verifiedArtist: "Stephen Paul Shaw",
    },
  };

  try {
    const startTime = Date.now();
    const result = await MasterPipelineRunner.executeMasterPipeline(testPayload);
    const duration = Date.now() - startTime;

    console.log(`[VERIFICATION COMPLETE] Execution finished in ${duration}ms`);
    console.log(`[PIPELINE STATUS]: ${result.status}`);

    if (result.status === "MASTER_PIPELINE_SUCCESS") {
      const { blueprints, settlement, providerPayload } = result;

      console.log("\n--- 20/20 NODE BLUEPRINT MANIFEST ---");
      console.log(
        "• Influence Blueprint ID:",
        blueprints.influenceBlueprint.influenceBlueprintId,
      );
      console.log(
        "• BPM Grid (Bar Duration):",
        `${blueprints.bpmBlueprint.barDurationMs}ms`,
      );
      console.log(
        "• Rhythm Coherence Score:",
        blueprints.rhythmBlueprint.rhythmCoherenceScore,
      );
      console.log(
        "• Rhythm Swing / Accents:",
        `${blueprints.rhythmBlueprint.swingFactor} / [${blueprints.rhythmBlueprint.accentPositions.join(",")}]`,
      );
      console.log(
        "• Classical Theory Key:",
        `${blueprints.theoryBlueprint.tonicNote} ${blueprints.theoryBlueprint.mode}`,
      );
      console.log(
        "• Diatonic Triads:",
        blueprints.theoryBlueprint.diatonicTriads.map((t) => t.roman).join(" "),
      );
      console.log(
        "• Ontology Compliance Norm:",
        blueprints.philosophyBlueprint.enforcedComplianceNorm,
      );
      console.log(
        "• Ontology Thickness / Contour:",
        `${blueprints.philosophyBlueprint.ontologicalThicknessScore} / ${blueprints.philosophyBlueprint.expressiveContourMatchIndex}`,
      );
      console.log(
        "• Lyric Coherence:",
        blueprints.lyricBlueprint.lyricStyleCoherenceScore,
      );
      console.log("• Vocal Alignment Takes:", blueprints.vocalAlignmentResults.length);
      console.log(
        "• Vocal Balance Coherence:",
        blueprints.vocalBalanceBlueprint.masterpieceCoherenceIndex,
      );
      console.log("• Wierdness Verdict:", blueprints.wierdnessBlueprint.wierdnessVerdict);
      console.log(
        "• Decompression Ceiling:",
        `${blueprints.decompression.peakLimitingCeilingDb} dB`,
      );
      console.log("• Ledger Settlement ID:", settlement.settlementId);
      console.log("• Vault Asset Target:", settlement.vaultAssetId);
      console.log("• Publisher Sync:", settlement.publisherSyncStatus);
      console.log(
        "• Provider Dispatch Node:",
        providerPayload.metadataStamps?.targetNode ?? "(n/a)",
      );
      console.log("-------------------------------------\n");

      const checks: Array<[string, boolean]> = [
        ["influence blueprint", Boolean(blueprints.influenceBlueprint.influenceBlueprintId)],
        ["bpm grid", blueprints.bpmBlueprint.barDurationMs === 2000],
        ["logical rhythm", blueprints.rhythmBlueprint.rhythmCoherenceScore >= 0.97],
        ["rhythm swing", blueprints.rhythmBlueprint.swingFactor === 0.101],
        [
          "classical theory key",
          blueprints.theoryBlueprint.tonicNote === "C" &&
            blueprints.theoryBlueprint.mode === "IONIAN",
        ],
        ["classical triads", blueprints.theoryBlueprint.diatonicTriads.length === 7],
        [
          "ontology compliance",
          blueprints.philosophyBlueprint.enforcedComplianceNorm ===
            "STRICT_SCORE_COMPLIANCE",
        ],
        [
          "ontology stable",
          blueprints.philosophyBlueprint.structuralCoherenceVerdict ===
            "ONTOLOGICALLY_STABLE",
        ],
        [
          "lyric enlinement",
          blueprints.lyricBlueprint.synchronizedArrangementProfiles.length >= 2,
        ],
        ["vocal alignment", blueprints.vocalAlignmentResults.length === 1],
        [
          "vocal balance",
          blueprints.vocalBalanceBlueprint.masterpieceCoherenceIndex >= 0.965,
        ],
        ["wierdness", Boolean(blueprints.wierdnessBlueprint.wierdnessVerdict)],
        ["dismantel", blueprints.dismantel.reallocatedStems.length > 0],
        ["structure", blueprints.inlinedStructure.totalBars > 0],
        ["decompression ceiling", blueprints.decompression.peakLimitingCeilingDb === -0.3],
        ["genre entitlement", Boolean(blueprints.genreEntitlement.genreVerified)],
        ["settlement id", Boolean(settlement.settlementId)],
        ["vault asset", Boolean(settlement.vaultAssetId)],
        ["provider payload", Boolean(providerPayload.metadataStamps?.targetNode)],
        ["publisher sync", Boolean(settlement.publisherSyncStatus)],
      ];

      const failed = checks.filter(([, ok]) => !ok);
      console.log(
        `[ASSERTIONS] ${checks.length - failed.length}/${checks.length} node checks passed.`,
      );
      if (failed.length > 0) {
        console.error(
          "[VERIFICATION ASSERTION FAILURES]:",
          failed.map(([name]) => name).join(", "),
        );
        process.exitCode = 1;
        return;
      }

      console.log(
        "All 20 nodes executed, enlined, and settled cleanly into the vault.",
      );
      process.exitCode = 0;
    } else {
      console.error("[PIPELINE FAULT DETECTED]:", result);
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error ?? "unknown");
    console.error("[VERIFICATION CRITICAL FAILURE]:", message);
    process.exitCode = 1;
  }
}

void runFullPipelineVerification();
