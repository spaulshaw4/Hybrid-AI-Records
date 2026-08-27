/**
 * Dispatch Alignment — sealed-core → external provider schema boundary.
 *
 * Keeps mathematical / isolation pipeline output separate from networking
 * provider contracts: enforces titles, genre vectors, acoustic params, and
 * metadata stamps (session nonce, request id, target node).
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type ProviderDispatchPayload = {
  trackTitle: string;
  genreVector: string;
  durationSeconds: number;
  acousticParameters: {
    temperature: number;
    chaosDrift: number;
    styleWeight: number;
  };
  metadataStamps: {
    sessionNonce: string;
    requestId: string;
    targetNode: string;
  };
};

export type CoreModulationInput = {
  trackTitle?: string;
  title?: string;
  genre?: string;
  style?: string;
  prompt?: string;
  durationSeconds?: number;
  temperature?: number;
  styleWeight?: number;
  chaosDrift?: number;
  organicDrift?: number;
  intuitiveStateFluctuator?: {
    chaosDrift?: number;
    organicDrift?: number;
  };
  parameters?: {
    temperature?: number;
    styleWeight?: number;
  };
};

export type MusicGenerationDispatchResult = {
  status: "DISPATCH_SUCCESS";
  providerAssetUrl: string;
  metadata: ProviderDispatchPayload["metadataStamps"];
  alignedPayload: ProviderDispatchPayload;
};

export class DispatchAlignment {
  /**
   * Aligns and transforms the sealed core pipeline output into the exact
   * schema required by external music generation providers.
   */
  static alignToProviderSchema(
    ctx: ExecutionContext,
    coreModulation: CoreModulationInput,
    targetNode: string,
  ): ProviderDispatchPayload {
    const requestShort = (ctx.requestId || "unknown").replace(/-/g, "").slice(0, 8);
    const trackTitle =
      (typeof coreModulation.trackTitle === "string" && coreModulation.trackTitle.trim()) ||
      (typeof coreModulation.title === "string" && coreModulation.title.trim()) ||
      `Track_${requestShort}`;

    const genreVector =
      (typeof coreModulation.genre === "string" && coreModulation.genre.trim()) ||
      (typeof coreModulation.style === "string" && coreModulation.style.trim()) ||
      (typeof coreModulation.prompt === "string" && coreModulation.prompt.trim()) ||
      "alternative_rock";

    const durationRaw = Number(coreModulation.durationSeconds);
    const durationSeconds =
      Number.isFinite(durationRaw) && durationRaw > 0 ? Math.min(600, Math.trunc(durationRaw)) : 180;

    const temperature = coerceNumber(
      coreModulation.temperature ?? coreModulation.parameters?.temperature,
      0.72,
      0.1,
      1.0,
    );
    const styleWeight = coerceNumber(
      coreModulation.styleWeight ?? coreModulation.parameters?.styleWeight,
      0.85,
      0.4,
      1.0,
    );
    const chaosDrift = coerceNumber(
      coreModulation.chaosDrift ??
        coreModulation.organicDrift ??
        coreModulation.intuitiveStateFluctuator?.chaosDrift ??
        coreModulation.intuitiveStateFluctuator?.organicDrift,
      0,
      -0.1,
      0.1,
    );

    const node = (targetNode || "standard-worker-grid-pool").trim() || "standard-worker-grid-pool";

    return {
      trackTitle: trackTitle.slice(0, 200),
      genreVector: genreVector.slice(0, 6000),
      durationSeconds,
      acousticParameters: {
        temperature,
        chaosDrift,
        styleWeight,
      },
      metadataStamps: {
        sessionNonce: ctx.sessionNonce,
        requestId: ctx.requestId,
        targetNode: node,
      },
    };
  }
}

/**
 * Align sealed core output, then hand off to a synthesis provider.
 * Production worker uses alignToProviderSchema + GenerationFactory;
 * this helper is the clean dry-run / mock dispatch path.
 */
export async function executeMusicGenerationDispatch(
  ctx: ExecutionContext,
  sealedCoreOutput: CoreModulationInput,
  assignedNode: string,
  options?: {
    /** Inject a real provider call; defaults to mock URL handoff. */
    dispatchFn?: (payload: ProviderDispatchPayload) => Promise<{ audioUrl: string }>;
  },
): Promise<MusicGenerationDispatchResult> {
  const payloadForProvider = DispatchAlignment.alignToProviderSchema(
    ctx,
    sealedCoreOutput,
    assignedNode,
  );

  const dispatchFn = options?.dispatchFn ?? mockCallAudioSynthesisProvider;
  const providerResponse = await dispatchFn(payloadForProvider);

  if (!providerResponse?.audioUrl?.trim()) {
    throw new Error("Dispatch Alignment Rejection: provider returned empty audio URL.");
  }

  return {
    status: "DISPATCH_SUCCESS",
    providerAssetUrl: providerResponse.audioUrl.trim(),
    metadata: payloadForProvider.metadataStamps,
    alignedPayload: payloadForProvider,
  };
}

async function mockCallAudioSynthesisProvider(
  payload: ProviderDispatchPayload,
): Promise<{ audioUrl: string }> {
  return {
    audioUrl: `https://storage.hybrid-ai-records.internal/vault/${payload.metadataStamps.sessionNonce}.wav`,
  };
}

function coerceNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Number(n.toFixed(4))));
}
