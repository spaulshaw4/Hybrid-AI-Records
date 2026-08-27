/**
 * Fluctuator Engine — algorithmic, zero-cost mid-pipeline modulator.
 *
 * Tier weights + InterpretiveLogic (prompt intent) + FormulaBasedIntuition
 * (sigmoid / hash micro-variation) + FNV entropy. No DB / LLM / external API.
 */

import { newCorrelationId } from "@/lib/engine-log.server";
import { PipelineFluxCoating } from "@/lib/PipelineFluxCoating";
import { DynamicLogicEngine } from "@/lib/DynamicLogicEngine";
import { InterpretiveLogic } from "@/lib/InterpretiveLogic";
import { FormulaBasedIntuition } from "@/lib/FormulaBasedIntuition";

export type FluctuatorUserTier = "free" | "pro" | "enterprise" | "consumer" | "premium" | string;

export type FluctuatorInput = {
  userId: string;
  basePrompt: string;
  userTier?: FluctuatorUserTier;
  sessionNonce: string;
  title?: string;
  style?: string;
  /** Optional soft hints — never require a network fetch. */
  preferencesHint?: Record<string, unknown>;
  /** Live queue pressure 0..1+ from DynamicLogicEngine / worker. */
  queueLoadFactor?: number;
};

/** @deprecated Prefer FluctuatorInput — kept as an alias for existing call sites. */
export type FluctuationContext = FluctuatorInput;

export type ModulatedGenerationEnvelope = {
  prompt: string;
  fluctuationNonce: string;
  parameters: {
    temperature: number;
    steps: number;
    /** Absolute bind — tracking never drifts to DEV / admin. */
    targetUserUuid: string;
    isolatedEnvironment: true;
    styleInfluence?: number;
    weirdness?: number;
    /** 0–1 style weight (algorithmic). */
    styleWeight?: number;
    tier: string;
    executionEngine: "algorithmic-deterministic";
  };
  profileSnapshot: {
    preferences: Record<string, unknown>;
    tokenBalance: number | null;
  };
};

export class FluctuatorRejectionError extends Error {
  readonly statusCode = 500 as const;

  constructor(message: string) {
    super(message);
    this.name = "FluctuatorRejectionError";
  }
}

const DEV_UUID = "11111111-1111-4111-8111-111111111111";

/** FNV-1a 32-bit — fast, deterministic, zero alloc beyond the string walk. */
export function algorithmicHash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeTier(raw?: string): "free" | "pro" | "enterprise" {
  const t = String(raw ?? "free").toLowerCase().trim();
  if (t === "enterprise" || t === "admin") return "enterprise";
  if (t === "pro" || t === "premium") return "pro";
  return "free";
}

/**
 * Deterministic parameter scaling from tier + interpretive intent + intuition curves.
 * Pure CPU — no I/O.
 */
export class FluctuatorEngine {
  /**
   * Instantly modulates generation parameters from user tier and session state.
   * Sync-safe; `await` still works at call sites.
   */
  static modulateGenerationParameters(input: FluctuatorInput): ModulatedGenerationEnvelope {
    const userId = input.userId?.trim() ?? "";
    if (!userId) {
      throw new FluctuatorRejectionError(
        "Fluctuator Rejection: Invalid or developer-bypassed user context.",
      );
    }
    if (userId === DEV_UUID || /dev[_-]?test/i.test(userId)) {
      throw new FluctuatorRejectionError(
        "Fluctuator Rejection: Invalid or developer-bypassed user context.",
      );
    }

    const hintTier =
      typeof input.preferencesHint?.tier === "string"
        ? input.preferencesHint.tier
        : typeof input.preferencesHint?.plan === "string"
          ? input.preferencesHint.plan
          : undefined;
    const tier = normalizeTier(input.userTier ?? hintTier);
    const isPro = tier === "pro" || tier === "enterprise";

    const prompt = (input.basePrompt ?? "").trim() || "instrumental";
    const styleBlob = [prompt, input.style ?? "", input.title ?? ""].join(" ");

    // 1. Interpretive Logic — semantic markers → deltas + complexity.
    const interpreted = InterpretiveLogic.interpretPrompt(styleBlob);

    // 2. Tier baselines.
    const baseTemperature = isPro ? 0.85 : 0.72;
    const baseSteps = isPro ? 150 : 100;
    const baseStyleWeight = isPro ? 0.9 : 0.75;

    // 3. Formula-Based Intuition — sigmoid temperature from complexity.
    let temperature = FormulaBasedIntuition.computeIntuitiveTemperature(
      interpreted.complexityScore,
      baseTemperature + interpreted.tempDelta,
    );

    // 4. Hash micro-variation (sin/log on FNV) — natural, deterministic.
    const entropy = algorithmicHash32(
      `${userId}|${input.sessionNonce}|${tier}|${prompt.slice(0, 64)}`,
    );
    temperature = clamp(
      temperature + FormulaBasedIntuition.hashMicroVariation(entropy),
      0.4,
      1.2,
    );

    const steps = Math.trunc(
      clamp(baseSteps + interpreted.stepsDelta + ((entropy >>> 8) % 11) * (isPro ? 1 : 0), 50, 200),
    );
    const styleWeight = clamp(baseStyleWeight + interpreted.styleDelta, 0.4, 1);
    const styleInfluence = Math.trunc(clamp(styleWeight * 100, 0, 100));
    const weirdness = Math.trunc(
      clamp(((entropy >>> 16) % (isPro ? 41 : 31)) + Math.abs(interpreted.styleDelta) * 40, 0, 100),
    );

    // 5. Dynamic Logic: tighten under live queue pressure.
    const loadFactor =
      typeof input.queueLoadFactor === "number" && Number.isFinite(input.queueLoadFactor)
        ? input.queueLoadFactor
        : 0;
    if (loadFactor > 0) {
      const scaled = DynamicLogicEngine.applyDynamicScaling(temperature, loadFactor);
      temperature = scaled.adjustedTemperature;
    }

    const nonce = input.sessionNonce?.trim() || FluctuatorEngine.newSessionNonce();

    const modulatedPayload: ModulatedGenerationEnvelope = {
      prompt,
      fluctuationNonce: nonce,
      parameters: {
        temperature: Number(temperature.toFixed(3)),
        steps,
        targetUserUuid: userId,
        isolatedEnvironment: true,
        styleInfluence,
        weirdness,
        styleWeight: Number(styleWeight.toFixed(3)),
        tier,
        executionEngine: "algorithmic-deterministic",
      },
      profileSnapshot: {
        preferences: {
          ...(input.preferencesHint ?? {}),
          tier,
          algorithmic: true,
          interpretive: {
            matchedTokens: interpreted.matchedTokens,
            complexityScore: interpreted.complexityScore,
            tempDelta: interpreted.tempDelta,
            stepsDelta: interpreted.stepsDelta,
            styleDelta: interpreted.styleDelta,
            vectors: interpreted.vectors,
          },
          title: input.title ?? null,
          style: input.style ?? null,
        },
        tokenBalance: null,
      },
    };

    // Flux Coating — reject impure envelopes before provider dispatch.
    const coated = PipelineFluxCoating.coatFluctuated(modulatedPayload);

    return coated as ModulatedGenerationEnvelope;
  }

  /** Convenience: mint a per-job session nonce for the fluctuator. */
  static newSessionNonce(jobId?: string): string {
    const base = newCorrelationId("fluct");
    return jobId ? `${base}_${jobId.slice(0, 8)}` : base;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
