/**
 * Master Pipeline Runner — fully integrated perimeter → music → settlement circuit.
 *
 * Closed-loop dry-run / architecture composer covering proactive defense,
 * isolation, style influence, BPM/rhythm, classical theory harmony, musical
 * ontology & logic, lyric/vocal enlinement, algorithmic vocal balance, wierdness,
 * dismantel, structure, decompression, dispatch alignment, ledger settlement,
 * and ground.
 * Production workers still drain via Cortex queue + GenerationFactory.
 */

import type { ExecutionTier } from "@/lib/ExecutionContext";
import { ContextFactory } from "@/lib/ExecutionContext";
import { ProactiveFlowEnforcer } from "@/lib/ProactiveFlowEnforcer";
import { BinaryEntanglementSuppressor } from "@/lib/BinaryEntanglementSuppressor";
import { DeepIsolationPlacement } from "@/lib/DeepIsolationPlacement";
import { IntuitiveStateFluctuator } from "@/lib/IntuitiveStateFluctuator";
import { CtxFluctuatorEngine } from "@/lib/CtxFluctuatorEngine";
import {
  StyleInfluenceEnlightment,
  type MusicalInfluenceArchetype,
  type InfluenceBlueprint,
} from "@/lib/StyleInfluenceEnlightment";
import {
  ClassicalTheoryEngine,
  type TheoryBlueprint,
  type ScaleMode,
} from "@/lib/ClassicalTheoryEngine";
import {
  MusicalOntologyAndLogicEngine,
  type PhilosophyLogicBlueprint,
  type WorkOntologyType,
  type ListeningPerspective,
  type ExpressiveValence,
} from "@/lib/MusicalOntologyAndLogicEngine";
import { BpmEnlinement, type BpmTimingBlueprint } from "@/lib/BpmEnlinement";
import {
  LogicalRhythmEnlinement,
  type LogicalRhythmBlueprint,
} from "@/lib/LogicalRhythmEnlinement";
import {
  StyleLyricEnlinement,
  type LyricSegmentInput,
  type LyricEnlinementResult,
} from "@/lib/StyleLyricEnlinement";
import {
  RecordedVoiceStructureEnlinement,
  type RecordedVocalTake,
  type StructuredVocalAlignmentResult,
} from "@/lib/RecordedVoiceStructureEnlinement";
import {
  AlgorithmicVocalBalance,
  type VocalBalanceBlueprint,
} from "@/lib/AlgorithmicVocalBalance";
import { WierdnessEnlinement, type WierdnessBlueprint } from "@/lib/WierdnessEnlinement";
import { IntuitiveDismantelPlacement } from "@/lib/IntuitiveDismantelPlacement";
import { MusicStructureInlining } from "@/lib/MusicStructureInlining";
import { DecompressionEnlinement } from "@/lib/DecompressionEnlinement";
import { GenreEntitlementPlacement } from "@/lib/GenreEntitlementPlacement";
import { DispatchAlignment, type ProviderDispatchPayload } from "@/lib/DispatchAlignment";
import { TelemetryAlignment } from "@/lib/TelemetryAlignment";
import {
  LedgerSettlementGate,
  type SettlementReceipt,
} from "@/lib/LedgerSettlementGate";
import {
  IsolatedGroundConnector,
  type GroundFaultPayload,
} from "@/lib/IsolatedGroundConnector";

export type MasterPipelineInput = {
  userId: string;
  tier: ExecutionTier;
  genreArchetype: MusicalInfluenceArchetype;
  masterBpm: number;
  lyricSegments: LyricSegmentInput[];
  recordedVocalTakes?: RecordedVocalTake[];
  chaosFactor: number;
  rawPayload: unknown;
  /** Optional explicit genre entitlement override (else inferred from payload / archetype). */
  supportedGenreHint?: string;
  /** Optional meter override (defaults 4/4). */
  timeSignatureNumerator?: number;
  timeSignatureDenominator?: number;
  /** Optional syncopation 0–1 (else derived from chaos / controls). */
  syncopationThreshold?: number;
  /** Optional tonic (else derived from archetype / payload key). */
  tonicNote?: string;
  /** Optional scale mode (else derived from archetype / payload). */
  scaleMode?: ScaleMode;
  /** Optional musical ontology work type. */
  workOntologyType?: WorkOntologyType;
  /** Optional listening perspective (moment vs large-scale). */
  listeningMode?: ListeningPerspective;
  /** Optional expressive valence for contour theory. */
  expressiveValence?: ExpressiveValence;
};

export type MasterPipelineBlueprints = {
  influenceBlueprint: InfluenceBlueprint;
  bpmBlueprint: BpmTimingBlueprint;
  rhythmBlueprint: LogicalRhythmBlueprint;
  theoryBlueprint: TheoryBlueprint;
  philosophyBlueprint: PhilosophyLogicBlueprint;
  lyricBlueprint: LyricEnlinementResult;
  vocalAlignmentResults: StructuredVocalAlignmentResult[];
  vocalBalanceBlueprint: VocalBalanceBlueprint;
  wierdnessBlueprint: WierdnessBlueprint;
  dismantel: ReturnType<typeof IntuitiveDismantelPlacement.executeDismantelPlacement>;
  inlinedStructure: ReturnType<typeof MusicStructureInlining.inlineArrangementStructure>;
  decompression: ReturnType<typeof DecompressionEnlinement.executeDecompressionEnlinement>;
  genreEntitlement: ReturnType<
    typeof GenreEntitlementPlacement.verifyAndEnforceEntitlement
  >;
};

export type MasterPipelineSuccess = {
  status: "MASTER_PIPELINE_SUCCESS";
  settlement: SettlementReceipt;
  blueprints: MasterPipelineBlueprints;
  providerPayload: ProviderDispatchPayload;
};

export type MasterPipelineGrounded = {
  status: "MASTER_PIPELINE_GROUNDED_FAULT";
  groundReference: string;
  faultSource: string;
  errorCode: string;
};

export type MasterPipelineOutcome = MasterPipelineSuccess | MasterPipelineGrounded;

export class MasterPipelineRunner {
  /**
   * Executes the complete closed-loop music production pipeline featuring
   * classical music theory harmony generation, logical rhythm, and vocal balancing.
   */
  static async executeMasterPipeline(
    input: MasterPipelineInput,
  ): Promise<MasterPipelineOutcome> {
    const ctx = ContextFactory.create(input.userId, input.tier, "master-pipeline-runner");

    try {
      // 1. PERIMETER PROACTIVE DEFENSE
      const preflight = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
      TelemetryAlignment.emit(ctx, {
        eventType: "PREFLIGHT_EVALUATION",
        status: preflight.allowed ? "SUCCESS" : "FAULT",
        details: { allowed: preflight.allowed, reason: preflight.reason ?? null },
      });
      if (!preflight.allowed) {
        throw new Error(`[PREFLIGHT REJECTED] ${preflight.reason ?? "FLOW_ENFORCEMENT_REJECTED"}`);
      }

      // 2. BINARY SUPPRESSION & ISOLATION
      const payloadRecord = toPayloadRecord(input.rawPayload);
      const isolatedPayload = BinaryEntanglementSuppressor.suppressCrossTalk(ctx, payloadRecord);
      TelemetryAlignment.emit(ctx, {
        eventType: "BINARY_SUPPRESSION_APPLIED",
        status: "SUCCESS",
        details: {
          entanglementState: isolatedPayload.__entanglementState ?? "SUPPRESSED_ORTHOGONAL",
        },
      });

      const placement = await DeepIsolationPlacement.routeAndPlace(ctx, isolatedPayload);
      if (placement.securityVerdict === "QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Payload quarantined at node ${placement.targetClusterNode}`,
        );
      }

      // 2b. GENRE ENTITLEMENT (BPM bounds)
      const supportedGenre = GenreEntitlementPlacement.resolveSupportedGenre(
        input.supportedGenreHint ||
          placement.sanitizedPayload.genre ||
          placement.sanitizedPayload.style ||
          archetypeToGenreHint(input.genreArchetype),
      );
      const genreEntitlement = GenreEntitlementPlacement.verifyAndEnforceEntitlement(
        ctx,
        supportedGenre,
        input.masterBpm,
      );
      if (genreEntitlement.entitlementStatus === "GENRE_MISMATCH_QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Genre entitlement mismatch for ${genreEntitlement.genreVerified} at ${input.masterBpm} BPM`,
        );
      }

      // 3. STYLE INFLUENCE ENLIGHTMENT
      const influenceBlueprint = StyleInfluenceEnlightment.enlighteneStyleInfluence(
        ctx,
        input.genreArchetype,
      );

      // 4. BPM ENLINEMENT
      const bpmBlueprint = BpmEnlinement.enlineBpmGrid(ctx, {
        masterBpm: input.masterBpm,
        timeSignatureNumerator: input.timeSignatureNumerator,
        timeSignatureDenominator: input.timeSignatureDenominator,
      });

      // 4b. LOGICAL RHYTHM ENLINEMENT — subdivision / swing / accents
      const rhythmPattern = LogicalRhythmEnlinement.deriveRhythmPatternInput({
        bpmTiming: bpmBlueprint,
        syncopationThreshold: input.syncopationThreshold,
        chaosFactor: input.chaosFactor,
        controls:
          placement.sanitizedPayload.controls &&
          typeof placement.sanitizedPayload.controls === "object"
            ? placement.sanitizedPayload.controls
            : undefined,
      });
      const rhythmBlueprint = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, rhythmPattern);

      // 6. CLASSICAL THEORY ENGINE — tonal architecture & functional triads
      const derivedHarmony = ClassicalTheoryEngine.deriveTonicAndMode({
        genreArchetype: input.genreArchetype,
        tonicHint: input.tonicNote ?? placement.sanitizedPayload.tonicNote,
        modeHint: input.scaleMode ?? placement.sanitizedPayload.scaleMode,
        keyHint: placement.sanitizedPayload.key ?? placement.sanitizedPayload.musicalKey,
        genreHint: supportedGenre,
      });
      const theoryBlueprint = ClassicalTheoryEngine.deriveClassicalHarmonics(
        ctx,
        derivedHarmony.tonic,
        derivedHarmony.mode,
      );

      // Lyric segments resolved early so ontology can read expressive valence.
      const lyricSegments =
        Array.isArray(input.lyricSegments) && input.lyricSegments.length > 0
          ? input.lyricSegments
          : StyleLyricEnlinement.deriveSegmentsFromStudioPayload({
              ctx,
              lyrics: placement.sanitizedPayload.lyrics,
              genreHint: supportedGenre,
              instrumental: Boolean(placement.sanitizedPayload.instrumental),
            });

      // 6b. MUSICAL ONTOLOGY & LOGIC — thickness, compliance norms, expressive contour
      const philosophyInput = MusicalOntologyAndLogicEngine.derivePhilosophyLogicInput({
        genreArchetype: input.genreArchetype,
        lyricSegments,
        workTypeHint:
          input.workOntologyType ?? placement.sanitizedPayload.workOntologyType,
        listeningModeHint:
          input.listeningMode ?? placement.sanitizedPayload.listeningMode,
        expressiveValenceHint:
          input.expressiveValence ?? placement.sanitizedPayload.expressiveValence,
        genreHint: supportedGenre,
      });
      const philosophyBlueprint = MusicalOntologyAndLogicEngine.evaluateMusicalLogic(
        ctx,
        philosophyInput,
      );

      // 7. STYLE & LYRIC ENLINEMENT
      const lyricBlueprint = StyleLyricEnlinement.enlineLyricsWithStyle(ctx, lyricSegments);

      // 6. RECORDED VOICE STRUCTURE ENLINEMENT
      const vocalAlignmentResults = input.recordedVocalTakes?.length
        ? RecordedVoiceStructureEnlinement.enlineRecordedVocals(
            ctx,
            input.recordedVocalTakes,
            input.masterBpm,
          )
        : (() => {
            const derived = RecordedVoiceStructureEnlinement.deriveTakeFromStudioPayload({
              ctx,
              bpmTiming: bpmBlueprint,
              lyrics: placement.sanitizedPayload.lyrics,
              durationSeconds: placement.sanitizedPayload.durationSeconds,
              instrumental: Boolean(placement.sanitizedPayload.instrumental),
              hasVocalStem: !placement.sanitizedPayload.instrumental,
            });
            return derived
              ? [
                  RecordedVoiceStructureEnlinement.enlineRecordedVocal(
                    ctx,
                    derived,
                    input.masterBpm,
                  ),
                ]
              : [];
          })();

      // 6b. ALGORITHMIC VOCAL BALANCE — mid-carve + sidechain ducking lock-in
      const vocalBalanceInput = AlgorithmicVocalBalance.deriveVocalBalanceInput({
        lyricEnlinement: lyricBlueprint,
        vocalAlignments: vocalAlignmentResults,
        instrumental: Boolean(placement.sanitizedPayload.instrumental),
        vocalPeakRmsDb: placement.sanitizedPayload.vocalPeakRmsDb,
        vocalFundamentalHz: placement.sanitizedPayload.vocalFundamentalHz,
        emotionalIntensity: placement.sanitizedPayload.emotionalIntensity,
      });
      const vocalBalanceBlueprint = AlgorithmicVocalBalance.balanceVocals(
        ctx,
        vocalBalanceInput,
      );

      // 7. WIERDNESS ENLINEMENT
      const wierdnessBlueprint = WierdnessEnlinement.enlineWierdness(ctx, {
        chaosFactor: input.chaosFactor,
        targetElement: "MASTER_BUS",
      });

      // 8. CHAOTIC FLUCTUATION & MODULATION
      const prompt = extractPrompt(placement.sanitizedPayload);
      const fluxCoated = IntuitiveStateFluctuator.fluxCoatWithIntuition(ctx, prompt, 0.72);
      const title =
        typeof placement.sanitizedPayload.title === "string"
          ? placement.sanitizedPayload.title
          : undefined;
      const style =
        typeof placement.sanitizedPayload.style === "string"
          ? placement.sanitizedPayload.style
          : typeof placement.sanitizedPayload.genre === "string"
            ? placement.sanitizedPayload.genre
            : undefined;
      const finalModulation = CtxFluctuatorEngine.modulate(ctx, fluxCoated.prompt || prompt, {
        title,
        style,
      });

      // 8b–8d. DISMANTEL → STRUCTURE → DECOMPRESSION
      const inferredStems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
        ctx,
        hasMaster: true,
        hasInstrumental: true,
        hasVocal: !placement.sanitizedPayload.instrumental,
      });
      let dismantel = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, inferredStems);
      dismantel = IntuitiveDismantelPlacement.applyGenreSubBassRouting(
        dismantel,
        genreEntitlement.appliedRules.subBassRouting,
      );
      const arrangementBlocks = MusicStructureInlining.deriveBlocksFromDismantel(ctx, dismantel);
      const inlinedStructure = MusicStructureInlining.inlineArrangementStructure(
        ctx,
        arrangementBlocks,
      );
      const sectionDynamics = DecompressionEnlinement.deriveSectionDynamicsFromInline(
        ctx,
        inlinedStructure,
        { genreMasterLufs: genreEntitlement.appliedRules.masterLufsTarget },
      );
      const decompression = DecompressionEnlinement.executeDecompressionEnlinement(
        ctx,
        sectionDynamics,
      );

      // 9. DISPATCH ALIGNMENT & LEDGER SETTLEMENT
      const providerPayload = DispatchAlignment.alignToProviderSchema(
        ctx,
        {
          trackTitle: title,
          title,
          genre: style,
          style,
          prompt: finalModulation.modulatedPrompt,
          durationSeconds:
            typeof placement.sanitizedPayload.durationSeconds === "number"
              ? placement.sanitizedPayload.durationSeconds
              : undefined,
          temperature: finalModulation.parameters.temperature,
          styleWeight: finalModulation.parameters.styleWeight,
          organicDrift: fluxCoated.organicDrift,
          parameters: {
            temperature: finalModulation.parameters.temperature,
            styleWeight: finalModulation.parameters.styleWeight,
          },
        },
        placement.targetClusterNode,
      );

      await TelemetryAlignment.recordEvent(ctx, {
        eventType: "DISPATCH_ALIGNED",
        status: "SUCCESS",
        details: {
          targetNode: placement.targetClusterNode,
          influenceArchetype: input.genreArchetype,
          theoryKey: `${theoryBlueprint.tonicNote} ${theoryBlueprint.mode}`,
          theoryEngineId: theoryBlueprint.theoryEngineId,
          theoryCoherenceIndex: theoryBlueprint.theoryCoherenceIndex,
          ontologyEngineId: philosophyBlueprint.ontologyEngineId,
          enforcedComplianceNorm: philosophyBlueprint.enforcedComplianceNorm,
          ontologicalThicknessScore: philosophyBlueprint.ontologicalThicknessScore,
          structuralCoherenceVerdict: philosophyBlueprint.structuralCoherenceVerdict,
          vocalTakesEnlined: vocalAlignmentResults.length,
          masterBpm: input.masterBpm,
          chaosFactor: input.chaosFactor,
          rhythmBlueprintId: rhythmBlueprint.rhythmBlueprintId,
          swingFactor: rhythmBlueprint.swingFactor,
          vocalBalanceId: vocalBalanceBlueprint.balanceBlueprintId,
          masterpieceCoherenceIndex: vocalBalanceBlueprint.masterpieceCoherenceIndex,
          wierdnessVerdict: wierdnessBlueprint.wierdnessVerdict,
          peakLimitingCeilingDb: decompression.peakLimitingCeilingDb,
        },
      });

      const vaultAssetId = `vault_asset_${ctx.sessionNonce}_${Date.now()}`;
      const settlement = await LedgerSettlementGate.settleAndClose(ctx, vaultAssetId, 1);

      return {
        status: "MASTER_PIPELINE_SUCCESS",
        settlement,
        blueprints: {
          influenceBlueprint,
          bpmBlueprint,
          rhythmBlueprint,
          theoryBlueprint,
          philosophyBlueprint,
          lyricBlueprint,
          vocalAlignmentResults,
          vocalBalanceBlueprint,
          wierdnessBlueprint,
          dismantel,
          inlinedStructure,
          decompression,
          genreEntitlement,
        },
        providerPayload,
      };
    } catch (error: unknown) {
      // 10. ISOLATED GROUND CONNECTOR
      const err = error as { code?: string; message?: string; stack?: string };
      const groundPayload: GroundFaultPayload = {
        errorCode: err?.code || "MASTER_PIPELINE_FAULT",
        faultSource: IsolatedGroundConnector.classifyFaultSource(error),
        rawContaminatedData: err?.stack || err?.message || String(error ?? "unknown"),
        drainNonce: `drain_${ctx.sessionNonce}`,
      };
      const groundReference = await IsolatedGroundConnector.drainFaultToGround(
        ctx,
        groundPayload,
      );
      return {
        status: "MASTER_PIPELINE_GROUNDED_FAULT",
        groundReference,
        faultSource: groundPayload.faultSource,
        errorCode: groundPayload.errorCode,
      };
    }
  }
}

function archetypeToGenreHint(archetype: MusicalInfluenceArchetype): string {
  switch (archetype) {
    case "MODERN_TRAP_METAL_HYBRID":
      return "nu metal";
    case "DETROIT_INDUSTRIAL_GRIT":
      return "rap rock";
    case "BRITISH_POST_PUNK_TENSE":
      return "alternative rock";
    case "SEATTLE_90S_WALL_OF_SOUND":
    default:
      return "heavy alternative rock";
  }
}

function toPayloadRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { value: raw ?? null };
}

function extractPrompt(payload: Record<string, unknown>): string {
  for (const key of ["prompt", "genre", "style"] as const) {
    const v = payload[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
