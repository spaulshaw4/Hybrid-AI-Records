/**
 * Engine routing policy.
 *
 * MiniMax 2.6 is the primary engine: it handles every default, long-form and
 * full 7-minute master request cost-effectively. ElevenLabs (via Replicate) is
 * the secondary/backup engine and is strictly capped at 30 seconds so a short
 * clip can never turn into a timeout or an expensive out-of-pocket render.
 */
import { DEFAULT_RENDER_ENGINE, type RenderEngine } from "@/lib/render-engines";

/** Hard cap for the secondary engine, in seconds. */
export const ELEVENLABS_MAX_SECONDS = 30;

/** Default length used when a brief does not specify one. */
export const DEFAULT_LONGFORM_SECONDS = 180;

/** Longest master the primary engine will render (7 minutes). */
export const MINIMAX_MAX_SECONDS = 420;

export type EngineRoute = {
  engine: RenderEngine;
  /** Effective length after caps. Undefined means "engine default". */
  durationSeconds?: number;
  /** Set when the requested engine or length was changed by policy. */
  note?: string;
};

/**
 * Resolve the engine + length actually dispatched.
 *
 * - ElevenLabs with no length, or 30s or less -> ElevenLabs, capped at 30s.
 * - ElevenLabs asked for long-form (>30s) -> automatically routed to MiniMax.
 * - Anything else -> MiniMax, clamped to the 7-minute master ceiling.
 */
export function resolveEngineRoute(
  engine: RenderEngine | undefined,
  durationSeconds: number | undefined,
): EngineRoute {
  const requested = engine ?? DEFAULT_RENDER_ENGINE;

  if (requested === "hybrid") {
    if (durationSeconds !== undefined && durationSeconds > MINIMAX_MAX_SECONDS) {
      return {
        engine: "hybrid",
        durationSeconds: MINIMAX_MAX_SECONDS,
        note: `Length trimmed to the ${MINIMAX_MAX_SECONDS / 60}-minute master ceiling.`,
      };
    }
    return {
      engine: "hybrid",
      durationSeconds: durationSeconds ?? DEFAULT_LONGFORM_SECONDS,
    };
  }

  if (requested === "elevenlabs") {
    if (durationSeconds !== undefined && durationSeconds > ELEVENLABS_MAX_SECONDS) {
      return {
        engine: "minimax",
        durationSeconds: Math.min(durationSeconds, MINIMAX_MAX_SECONDS),
        note: `Short clips are limited to ${ELEVENLABS_MAX_SECONDS}s — this long-form render was routed to the full-length engine.`,
      };
    }
    const capped = Math.min(durationSeconds ?? ELEVENLABS_MAX_SECONDS, ELEVENLABS_MAX_SECONDS);
    return {
      engine: "elevenlabs",
      durationSeconds: capped,
      ...(durationSeconds === undefined
        ? { note: `Short clips are capped at ${ELEVENLABS_MAX_SECONDS}s.` }
        : {}),
    };
  }

  if (durationSeconds !== undefined && durationSeconds > MINIMAX_MAX_SECONDS) {
    return {
      engine: "minimax",
      durationSeconds: MINIMAX_MAX_SECONDS,
      note: `Length trimmed to the ${MINIMAX_MAX_SECONDS / 60}-minute master ceiling.`,
    };
  }

  return { engine: "minimax", ...(durationSeconds !== undefined ? { durationSeconds } : {}) };
}

/** User-facing copy for an over-length ElevenLabs brief. */
export const ELEVENLABS_LIMIT_MESSAGE =
  `Short clips are capped at ${ELEVENLABS_MAX_SECONDS} seconds. ` +
  `Shorten this render to ${ELEVENLABS_MAX_SECONDS}s or use the full-length engine for long-form masters.`;

/** Thrown when a brief violates the engine's hard limits. */
export class EngineLimitError extends Error {
  readonly engine: RenderEngine;
  readonly maxSeconds: number;
  readonly requestedSeconds: number;

  constructor(engine: RenderEngine, requestedSeconds: number, maxSeconds: number, message: string) {
    super(message);
    this.name = "EngineLimitError";
    this.engine = engine;
    this.requestedSeconds = requestedSeconds;
    this.maxSeconds = maxSeconds;
  }
}

/**
 * Server-side gate for engine + length. ElevenLabs briefs longer than 30s are
 * rejected outright, or re-sliced down to the 30s cap when the caller opted in
 * (`reslice: true`). Everything else falls through to the routing policy.
 */
export function validateEngineRequest(
  engine: RenderEngine | undefined,
  durationSeconds: number | undefined,
  options: { reslice?: boolean } = {},
): EngineRoute {
  const requested = engine ?? DEFAULT_RENDER_ENGINE;

  if (
    requested === "elevenlabs" &&
    durationSeconds !== undefined &&
    durationSeconds > ELEVENLABS_MAX_SECONDS
  ) {
    if (!options.reslice) {
      throw new EngineLimitError(
        "elevenlabs",
        durationSeconds,
        ELEVENLABS_MAX_SECONDS,
        ELEVENLABS_LIMIT_MESSAGE,
      );
    }
    return {
      engine: "elevenlabs",
      durationSeconds: ELEVENLABS_MAX_SECONDS,
      note: `Requested ${Math.round(durationSeconds)}s was re-sliced to the ${ELEVENLABS_MAX_SECONDS}s short-clip cap.`,
    };
  }

  return resolveEngineRoute(requested, durationSeconds);
}

