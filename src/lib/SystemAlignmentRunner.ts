/**
 * System Alignment Runner — unified perimeter → settlement contract.
 *
 * Prefer `MasterPipelineRunner.executeMasterPipeline` for the fully integrated
 * music production closed loop (influence → BPM → logical rhythm → classical
 * theory → musical ontology → lyric → recorded voice → algorithmic vocal balance →
 * wierdness → dismantel → structure → decompression → settlement).
 *
 * This runner remains the lighter architectural smoke / dry-run alignment path.
 * Production workers still drain via Cortex queue + GenerationFactory.
 */

import type { ExecutionTier } from "@/lib/ExecutionContext";
import { ContextFactory } from "@/lib/ExecutionContext";
import { ProactiveFlowEnforcer } from "@/lib/ProactiveFlowEnforcer";
import { BinaryEntanglementSuppressor } from "@/lib/BinaryEntanglementSuppressor";
import { DeepIsolationPlacement } from "@/lib/DeepIsolationPlacement";
import { IntuitiveStateFluctuator } from "@/lib/IntuitiveStateFluctuator";
import { CtxFluctuatorEngine } from "@/lib/CtxFluctuatorEngine";
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
import type { DismantelPlacementResult } from "@/lib/IntuitiveDismantelPlacement";
import type { InlinedStructureResult } from "@/lib/MusicStructureInlining";
import type { DecompressionResult } from "@/lib/DecompressionEnlinement";
import type { EntitlementVerificationResult } from "@/lib/GenreEntitlementPlacement";
import type { LyricEnlinementResult } from "@/lib/StyleLyricEnlinement";
import type { BpmTimingBlueprint } from "@/lib/BpmEnlinement";
import type { LogicalRhythmBlueprint } from "@/lib/LogicalRhythmEnlinement";
import type { TheoryBlueprint } from "@/lib/ClassicalTheoryEngine";
import type { PhilosophyLogicBlueprint } from "@/lib/MusicalOntologyAndLogicEngine";
import type { WierdnessBlueprint } from "@/lib/WierdnessEnlinement";
import type { InfluenceBlueprint } from "@/lib/StyleInfluenceEnlightment";
import type { StructuredVocalAlignmentResult } from "@/lib/RecordedVoiceStructureEnlinement";
import type { VocalBalanceBlueprint } from "@/lib/AlgorithmicVocalBalance";

export type AlignedPipelineSuccess = {
  status: "ALIGNED_EXECUTION_SUCCESS";
  settlement: SettlementReceipt;
  providerPayload: ProviderDispatchPayload;
  genreEntitlement: EntitlementVerificationResult;
  styleInfluence: InfluenceBlueprint;
  bpmTiming: BpmTimingBlueprint;
  rhythmBlueprint: LogicalRhythmBlueprint;
  theoryBlueprint: TheoryBlueprint;
  philosophyBlueprint: PhilosophyLogicBlueprint;
  recordedVoiceAlignments: StructuredVocalAlignmentResult[];
  lyricEnlinement: LyricEnlinementResult;
  vocalBalance: VocalBalanceBlueprint;
  wierdness: WierdnessBlueprint;
  dismantel: DismantelPlacementResult;
  inlinedStructure: InlinedStructureResult;
  decompression: DecompressionResult;
};

export type AlignedPipelineGrounded = {
  status: "ALIGNED_CIRCUIT_GROUNDED_FAULT";
  groundReference: string;
  faultSource: string;
  errorCode: string;
};

export type AlignedPipelineOutcome = AlignedPipelineSuccess | AlignedPipelineGrounded;

export class SystemAlignmentRunner {
  /**
   * Executes the fully aligned, end-to-end music generation pipeline with
   * synchronized telemetry, dispatch, and settlement gates.
   */
  static async runFullyAlignedPipeline(
    userId: string,
    tier: ExecutionTier,
    rawPayload: unknown,
  ): Promise<AlignedPipelineOutcome> {
    const ctx = ContextFactory.create(userId, tier, "aligned-runner");

    try {
      // 1. Perimeter Preflight
      const preflight = await ProactiveFlowEnforcer.enforcePreFlightFlow(ctx);
      TelemetryAlignment.emit(ctx, {
        eventType: "PREFLIGHT_EVALUATION",
        status: preflight.allowed ? "SUCCESS" : "FAULT",
        details: {
          allowed: preflight.allowed,
          reason: preflight.reason ?? null,
        },
      });
      if (!preflight.allowed) {
        throw new Error(`[PREFLIGHT REJECTED] ${preflight.reason ?? "FLOW_ENFORCEMENT_REJECTED"}`);
      }

      // 2. Binary Suppression
      const payloadRecord = toPayloadRecord(rawPayload);
      const isolated = BinaryEntanglementSuppressor.suppressCrossTalk(ctx, payloadRecord);
      TelemetryAlignment.emit(ctx, {
        eventType: "BINARY_SUPPRESSION_APPLIED",
        status: "SUCCESS",
        details: {
          entanglementState: isolated.__entanglementState ?? "SUPPRESSED_ORTHOGONAL",
        },
      });

      // 3. Deep Isolation & Placement
      const placement = await DeepIsolationPlacement.routeAndPlace(ctx, isolated);
      if (placement.securityVerdict === "QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Quarantined at node ${placement.targetClusterNode}`,
        );
      }

      const prompt = extractPrompt(placement.sanitizedPayload);
      const baseTemp = extractTemperature(placement.sanitizedPayload, 0.72);

      // 4. Chaotic Intuition & Fluctuation
      const fluxCoated = IntuitiveStateFluctuator.fluxCoatWithIntuition(ctx, prompt, baseTemp);
      TelemetryAlignment.emit(ctx, {
        eventType: "CHAOTIC_FLUCTUATION_APPLIED",
        status: "SUCCESS",
        details: {
          organicDrift: fluxCoated.organicDrift,
          resolvedTemperature: fluxCoated.resolvedTemperature,
        },
      });

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

      const modulated = CtxFluctuatorEngine.modulate(ctx, fluxCoated.prompt || prompt, {
        title,
        style,
      });

      // 5. Dispatch Alignment (Ready for Provider Handoff)
      const providerPayload = DispatchAlignment.alignToProviderSchema(
        ctx,
        {
          trackTitle: title,
          title,
          genre: style,
          style,
          prompt: modulated.modulatedPrompt,
          durationSeconds:
            typeof placement.sanitizedPayload.durationSeconds === "number"
              ? placement.sanitizedPayload.durationSeconds
              : undefined,
          temperature: modulated.parameters.temperature,
          styleWeight: modulated.parameters.styleWeight,
          organicDrift: fluxCoated.organicDrift,
          parameters: {
            temperature: modulated.parameters.temperature,
            styleWeight: modulated.parameters.styleWeight,
          },
        },
        placement.targetClusterNode,
      );

      await TelemetryAlignment.recordEvent(ctx, {
        eventType: "DISPATCH_ALIGNED",
        status: "SUCCESS",
        details: {
          targetNode: placement.targetClusterNode,
          securityVerdict: placement.securityVerdict,
          providerPayloadKeys: Object.keys(providerPayload),
          trackTitle: providerPayload.trackTitle,
        },
      });

      // 5a. Genre Entitlement — stylistic DNA / BPM gate
      const { GenreEntitlementPlacement } = await import("@/lib/GenreEntitlementPlacement");
      const targetGenre = GenreEntitlementPlacement.resolveSupportedGenre(
        placement.sanitizedPayload.genre ||
          placement.sanitizedPayload.style ||
          placement.sanitizedPayload.prompt ||
          providerPayload.genreVector,
      );
      const controls =
        placement.sanitizedPayload.controls &&
        typeof placement.sanitizedPayload.controls === "object"
          ? (placement.sanitizedPayload.controls as { bpm?: unknown })
          : undefined;
      const currentBpm = GenreEntitlementPlacement.resolveBpm(controls?.bpm, targetGenre);
      const genreEntitlement = GenreEntitlementPlacement.verifyAndEnforceEntitlement(
        ctx,
        targetGenre,
        currentBpm,
      );
      if (genreEntitlement.entitlementStatus === "GENRE_MISMATCH_QUARANTINED") {
        throw new Error(
          `[SECURITY HALT] Genre entitlement mismatch for ${genreEntitlement.genreVerified} at ${currentBpm} BPM`,
        );
      }

      const { StyleInfluenceEnlightment } = await import("@/lib/StyleInfluenceEnlightment");
      const influenceArchetype = StyleInfluenceEnlightment.resolveArchetype({
        genre: genreEntitlement.genreVerified,
        styleHint: placement.sanitizedPayload.style || placement.sanitizedPayload.genre,
        promptHint: placement.sanitizedPayload.prompt || providerPayload.genreVector,
      });
      const styleInfluence = StyleInfluenceEnlightment.enlighteneStyleInfluence(
        ctx,
        influenceArchetype,
      );

      const { BpmEnlinement } = await import("@/lib/BpmEnlinement");
      const bpmTiming = BpmEnlinement.enlineBpmGrid(ctx, {
        masterBpm: currentBpm,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
      });

      const { LogicalRhythmEnlinement } = await import("@/lib/LogicalRhythmEnlinement");
      const rhythmPattern = LogicalRhythmEnlinement.deriveRhythmPatternInput({
        bpmTiming,
        chaosFactor:
          placement.sanitizedPayload.controls &&
          typeof placement.sanitizedPayload.controls === "object"
            ? (placement.sanitizedPayload.controls as { weirdness?: unknown }).weirdness
            : providerPayload.acousticParameters.chaosDrift,
        controls: placement.sanitizedPayload.controls,
      });
      const rhythmBlueprint = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, rhythmPattern);

      const { ClassicalTheoryEngine } = await import("@/lib/ClassicalTheoryEngine");
      const derivedHarmony = ClassicalTheoryEngine.deriveTonicAndMode({
        genreArchetype: influenceArchetype,
        tonicHint: placement.sanitizedPayload.tonicNote ?? placement.sanitizedPayload.key,
        modeHint: placement.sanitizedPayload.scaleMode ?? placement.sanitizedPayload.mode,
        keyHint: placement.sanitizedPayload.key ?? placement.sanitizedPayload.musicalKey,
        genreHint:
          placement.sanitizedPayload.genre ||
          placement.sanitizedPayload.style ||
          providerPayload.genreVector,
      });
      const theoryBlueprint = ClassicalTheoryEngine.deriveClassicalHarmonics(
        ctx,
        derivedHarmony.tonic,
        derivedHarmony.mode,
      );

      const { StyleLyricEnlinement } = await import("@/lib/StyleLyricEnlinement");
      const lyricSegments = StyleLyricEnlinement.deriveSegmentsFromStudioPayload({
        ctx,
        lyrics: placement.sanitizedPayload.lyrics,
        genreHint:
          placement.sanitizedPayload.genre ||
          placement.sanitizedPayload.style ||
          providerPayload.genreVector,
        instrumental: Boolean(placement.sanitizedPayload.instrumental),
      });

      const { MusicalOntologyAndLogicEngine } = await import(
        "@/lib/MusicalOntologyAndLogicEngine"
      );
      const philosophyInput = MusicalOntologyAndLogicEngine.derivePhilosophyLogicInput({
        genreArchetype: influenceArchetype,
        lyricSegments,
        workTypeHint: placement.sanitizedPayload.workOntologyType,
        listeningModeHint: placement.sanitizedPayload.listeningMode,
        expressiveValenceHint: placement.sanitizedPayload.expressiveValence,
        genreHint:
          placement.sanitizedPayload.genre ||
          placement.sanitizedPayload.style ||
          providerPayload.genreVector,
      });
      const philosophyBlueprint = MusicalOntologyAndLogicEngine.evaluateMusicalLogic(
        ctx,
        philosophyInput,
      );

      const { RecordedVoiceStructureEnlinement } = await import(
        "@/lib/RecordedVoiceStructureEnlinement"
      );
      const derivedVocalTake = RecordedVoiceStructureEnlinement.deriveTakeFromStudioPayload({
        ctx,
        bpmTiming,
        voiceId: placement.sanitizedPayload.voiceId,
        referenceAudioUrl: placement.sanitizedPayload.referenceAudioUrl,
        durationSeconds:
          placement.sanitizedPayload.durationSeconds ?? providerPayload.durationSeconds,
        lyrics: placement.sanitizedPayload.lyrics,
        instrumental: Boolean(placement.sanitizedPayload.instrumental),
        hasVocalStem: !placement.sanitizedPayload.instrumental,
      });
      const recordedVoiceAlignments = derivedVocalTake
        ? [
            RecordedVoiceStructureEnlinement.enlineRecordedVocal(
              ctx,
              derivedVocalTake,
              bpmTiming.masterBpm,
            ),
          ]
        : [];

      const lyricEnlinement = StyleLyricEnlinement.enlineLyricsWithStyle(ctx, lyricSegments);

      const { AlgorithmicVocalBalance } = await import("@/lib/AlgorithmicVocalBalance");
      const vocalBalanceInput = AlgorithmicVocalBalance.deriveVocalBalanceInput({
        lyricEnlinement,
        vocalAlignments: recordedVoiceAlignments,
        instrumental: Boolean(placement.sanitizedPayload.instrumental),
        vocalPeakRmsDb: placement.sanitizedPayload.vocalPeakRmsDb,
        vocalFundamentalHz: placement.sanitizedPayload.vocalFundamentalHz,
        emotionalIntensity: placement.sanitizedPayload.emotionalIntensity,
      });
      const vocalBalance = AlgorithmicVocalBalance.balanceVocals(ctx, vocalBalanceInput);

      const { WierdnessEnlinement } = await import("@/lib/WierdnessEnlinement");
      const chaosFactor = WierdnessEnlinement.resolveChaosFactor({
        weirdness:
          placement.sanitizedPayload.controls &&
          typeof placement.sanitizedPayload.controls === "object"
            ? (placement.sanitizedPayload.controls as { weirdness?: unknown }).weirdness
            : undefined,
        acousticChaosDrift: providerPayload.acousticParameters.chaosDrift,
      });
      const wierdness = WierdnessEnlinement.enlineWierdness(ctx, {
        chaosFactor,
        targetElement: WierdnessEnlinement.resolveTargetElement({
          instrumental: Boolean(placement.sanitizedPayload.instrumental),
          hasVocal: !placement.sanitizedPayload.instrumental,
          genreHint: placement.sanitizedPayload.genre || providerPayload.genreVector,
        }),
      });

      // 5b. Intuitive Dismantel Placement (spatial / frequency stem reallocation)
      const { IntuitiveDismantelPlacement } = await import("@/lib/IntuitiveDismantelPlacement");
      const inferredStems = IntuitiveDismantelPlacement.deriveStemsFromGenerationResult({
        ctx,
        hasMaster: true,
        hasInstrumental: true,
        hasVocal: ctx.tier !== "free",
      });
      let dismantel = IntuitiveDismantelPlacement.executeDismantelPlacement(ctx, inferredStems);
      dismantel = IntuitiveDismantelPlacement.applyGenreSubBassRouting(
        dismantel,
        genreEntitlement.appliedRules.subBassRouting,
      );

      const { MusicStructureInlining } = await import("@/lib/MusicStructureInlining");
      const arrangementBlocks = MusicStructureInlining.deriveBlocksFromDismantel(ctx, dismantel);
      const inlinedStructure = MusicStructureInlining.inlineArrangementStructure(
        ctx,
        arrangementBlocks,
      );

      const { DecompressionEnlinement } = await import("@/lib/DecompressionEnlinement");
      const sectionDynamics = DecompressionEnlinement.deriveSectionDynamicsFromInline(
        ctx,
        inlinedStructure,
        { genreMasterLufs: genreEntitlement.appliedRules.masterLufsTarget },
      );
      const decompression = DecompressionEnlinement.executeDecompressionEnlinement(
        ctx,
        sectionDynamics,
      );

      // 6. Vault & Ledger Settlement (dry-run vault id; production uses End-Gate)
      const vaultAssetId = `vault_${ctx.sessionNonce}_${Date.now()}`;
      const settlement = await LedgerSettlementGate.settleAndClose(ctx, vaultAssetId, 1);

      return {
        status: "ALIGNED_EXECUTION_SUCCESS" as const,
        settlement,
        providerPayload,
        genreEntitlement,
        styleInfluence,
        bpmTiming,
        rhythmBlueprint,
        theoryBlueprint,
        philosophyBlueprint,
        recordedVoiceAlignments,
        lyricEnlinement,
        vocalBalance,
        wierdness,
        dismantel,
        inlinedStructure,
        decompression,
      };
    } catch (error: unknown) {
      // 7. Isolated Ground Fault Diverters
      const err = error as { code?: string; message?: string; stack?: string };
      const groundPayload: GroundFaultPayload = {
        errorCode: err?.code || "ALIGNED_PIPELINE_FAULT",
        faultSource: IsolatedGroundConnector.classifyFaultSource(error),
        rawContaminatedData: err?.stack || err?.message || String(error ?? "unknown"),
        drainNonce: `drain_${ctx.sessionNonce}`,
      };
      const groundReference = await IsolatedGroundConnector.drainFaultToGround(
        ctx,
        groundPayload,
      );
      return {
        status: "ALIGNED_CIRCUIT_GROUNDED_FAULT",
        groundReference,
        faultSource: groundPayload.faultSource,
        errorCode: groundPayload.errorCode,
      };
    }
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

function extractTemperature(payload: Record<string, unknown>, fallback: number): number {
  const raw = payload.temperature;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
