/**
 * CTX Fluctuator — modulates generation strictly from an immutable ExecutionContext.
 *
 * Pipeline: FluctuatorEngine (interpretive + formula) → IntuitiveStateFluctuator
 * (logistic-map drift) → Flux coating. Identity only from sealed CTX.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { ContextRejectionError } from "@/lib/ExecutionContext";
import {
  FluctuatorEngine,
  type ModulatedGenerationEnvelope,
} from "@/lib/FluctuatorEngine";
import { IntuitiveStateFluctuator } from "@/lib/IntuitiveStateFluctuator";
import { PipelineFluxCoating } from "@/lib/PipelineFluxCoating";

export type ModulatedOutput = {
  modulatedPrompt: string;
  fluctuationNonce: string;
  parameters: {
    temperature: number;
    steps: number;
    styleWeight: number;
    targetUserUuid: string;
    isolatedEnvironment: true;
    styleInfluence?: number;
    weirdness?: number;
    tier: string;
    executionEngine: "algorithmic-deterministic";
  };
  /** Full envelope for worker / End-Gate / flux coating (includes profileSnapshot). */
  envelope: ModulatedGenerationEnvelope;
};

export class CtxFluctuatorEngine {
  /**
   * Modulates generation parameters purely based on the immutable ExecutionContext.
   */
  static modulate(
    ctx: ExecutionContext,
    basePrompt: string,
    options?: {
      queueLoadFactor?: number;
      title?: string;
      style?: string;
    },
  ): ModulatedOutput {
    if (!ctx?.userId) {
      throw new ContextRejectionError(
        "CTX Fluctuator Rejection: Context missing target user UUID.",
      );
    }

    // 1. Algorithmic core — interpretive + formula intuition, CTX-bound.
    const envelope = FluctuatorEngine.modulateGenerationParameters({
      userId: ctx.userId,
      basePrompt,
      userTier: ctx.tier,
      sessionNonce: ctx.sessionNonce,
      title: options?.title,
      style: options?.style,
      queueLoadFactor: options?.queueLoadFactor,
      preferencesHint: {
        requestId: ctx.requestId,
        sourceGate: ctx.sourceGate,
        jobId: ctx.jobId ?? null,
        ctxTimestamp: ctx.timestamp,
        tier: ctx.tier,
      },
    });

    if (envelope.parameters.targetUserUuid !== ctx.userId) {
      throw new ContextRejectionError(
        "CTX Fluctuator Rejection: Modulated targetUserUuid drifted from ExecutionContext.",
      );
    }

    // 2. Probabilistic state-space drift — logistic map seeded by CTX.requestId.
    const intuitive = IntuitiveStateFluctuator.fluxCoatWithIntuition(
      ctx,
      envelope.prompt,
      envelope.parameters.temperature,
      envelope.parameters.styleWeight,
    );

    const driftedTemp = intuitive.resolvedTemperature;
    const driftedStyle =
      intuitive.resolvedStyleWeight ??
      envelope.parameters.styleWeight ??
      (ctx.tier === "free" ? 0.75 : 0.9);

    const driftedEnvelope: ModulatedGenerationEnvelope = {
      ...envelope,
      prompt: intuitive.prompt || envelope.prompt,
      fluctuationNonce: intuitive.stateNonce || envelope.fluctuationNonce,
      parameters: {
        ...envelope.parameters,
        temperature: driftedTemp,
        styleWeight: driftedStyle,
        styleInfluence: Math.trunc(Math.min(100, Math.max(0, driftedStyle * 100))),
        targetUserUuid: ctx.userId,
        isolatedEnvironment: true,
      },
      profileSnapshot: {
        ...envelope.profileSnapshot,
        preferences: {
          ...envelope.profileSnapshot.preferences,
          intuitiveStateFluctuator: {
            applied: true,
            organicDrift: intuitive.organicDrift,
            chaoticSeed: intuitive.chaoticSeed,
            preDriftTemperature: envelope.parameters.temperature,
            resolvedTemperature: driftedTemp,
          },
        },
      },
    };

    // 3. Re-coat after chaotic drift so End-Gate / provider always see flux-clean params.
    const coated = PipelineFluxCoating.coatFluctuated(driftedEnvelope) as ModulatedGenerationEnvelope;

    return {
      modulatedPrompt: coated.prompt,
      fluctuationNonce: coated.fluctuationNonce || ctx.sessionNonce,
      parameters: {
        temperature: coated.parameters.temperature,
        steps: coated.parameters.steps,
        styleWeight: coated.parameters.styleWeight ?? driftedStyle,
        targetUserUuid: ctx.userId,
        isolatedEnvironment: true,
        styleInfluence: coated.parameters.styleInfluence,
        weirdness: coated.parameters.weirdness,
        tier: coated.parameters.tier,
        executionEngine: "algorithmic-deterministic",
      },
      envelope: coated,
    };
  }
}
