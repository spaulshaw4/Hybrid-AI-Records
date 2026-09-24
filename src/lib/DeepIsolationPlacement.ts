/**
 * Deep Isolation Core Placement — detangle, saturate-check, place, audit.
 *
 * Runs the Detanglement Reactor, evaluates isolation integrity + node load,
 * then returns a PlacementEnvelope the worker uses before Fluctuator.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import {
  DetanglementReactor,
  type ReactorCoreState,
} from "@/lib/DetanglementReactor";
import { TelemetryAlignment } from "@/lib/TelemetryAlignment";

export type IsolationSecurityVerdict =
  | "PASSED_ISOLATION"
  | "QUARANTINED"
  | "FALLBACK_ROUTED";

export type PlacementEnvelope = {
  targetClusterNode: string;
  isolationLevel: string;
  reactorNonce: string;
  sanitizedPayload: Record<string, unknown>;
  securityVerdict: IsolationSecurityVerdict;
  reactorState: ReactorCoreState;
};

export type SecureCoreDispatch = {
  node: string;
  payload: Record<string, unknown>;
  nonce: string;
  isolationLevel: string;
  securityVerdict: IsolationSecurityVerdict;
  reactorState: ReactorCoreState;
};

const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** Bright major defaults for pop / country / reggae / funk. */
const MAJOR_KEYS = ["C major", "G major", "A major"] as const;
/** Rock / outlaw / blues pocket. */
const ROCK_KEYS = ["E major", "A minor"] as const;
/** Dark minor defaults for hip-hop / industrial / metal. */
const MINOR_KEYS = ["E minor", "D minor", "F# minor"] as const;

const GENRE_KEY_RULES: ReadonlyArray<{ re: RegExp; pool: readonly string[] }> = [
  { re: /\b(outlaw\s*country|rock|punk|blues|outlaw|indie)\b/i, pool: ROCK_KEYS },
  {
    re: /\b(hip[\s-]?hop|hiphop|trap|rap|metal|industrial|techno|dubstep|ambient|cinematic)\b/i,
    pool: MINOR_KEYS,
  },
  {
    re: /\b(pop|country|reggae|funk|disco|dance|house|soul|r&?b|folk)\b/i,
    pool: MAJOR_KEYS,
  },
];

function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Genre → mode when the user did not lock a keySignature. */
export function defaultKeyForGenre(genre: string, prompt = ""): string {
  const haystack = `${genre} ${prompt}`.trim() || "pop";
  const seed = hashSeed(haystack.toLowerCase());
  for (const rule of GENRE_KEY_RULES) {
    if (rule.re.test(haystack)) {
      return rule.pool[seed % rule.pool.length]!;
    }
  }
  return MAJOR_KEYS[seed % MAJOR_KEYS.length]!;
}

/**
 * Musical / prompt keys the audio reactor may see.
 * Queue-row metadata (spend keys, vault ids, timestamps, isolation stamps) is excluded.
 */
const COMPOSITION_ALLOWLIST = new Set([
  "prompt",
  "title",
  "style",
  "lyrics",
  "instrumental",
  "audioFormat",
  "voiceId",
  "termsAccepted",
  "language",
  "customLanguage",
  "customMode",
  "tags",
  "mv",
  "model",
  "engine",
  "durationSeconds",
  "allowReslice",
  "controls",
  "genre",
  "subGenre",
  "mood",
  "instruments",
  "vocalProfile",
  "vocalGender",
  "vocalTimbre",
  "vocalStyle",
  "referenceAudioUrl",
  "rvcModelUrl",
  "genreHint",
  "genre_hint",
  "bpm",
  "keySignature",
  "key_signature",
  "bars",
  "temperature",
]);

/**
 * Strip database / isolation metadata before quarantine-isolation-node.
 * Only composition properties reach the detanglement reactor.
 */
export function sanitizeCompositionInput(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const stripped = Object.keys(payload).filter((key) => !COMPOSITION_ALLOWLIST.has(key));
  if (stripped.length > 0) {
    console.warn("[DEEP ISOLATION] stripped non-composition keys before reactor", {
      stripped,
    });
  }

  const sanitized: Record<string, unknown> = {};
  for (const key of COMPOSITION_ALLOWLIST) {
    if (payload[key] !== undefined) sanitized[key] = payload[key];
  }

  const genre =
    (typeof sanitized.genre === "string" && sanitized.genre.trim()) ||
    (typeof sanitized.genreHint === "string" && sanitized.genreHint.trim()) ||
    (typeof sanitized.genre_hint === "string" && sanitized.genre_hint.trim()) ||
    (typeof sanitized.style === "string" && sanitized.style.trim()) ||
    "";
  if (genre) sanitized.genre = genre;

  const controlsRaw =
    sanitized.controls && typeof sanitized.controls === "object" && !Array.isArray(sanitized.controls)
      ? { ...(sanitized.controls as Record<string, unknown>) }
      : {};
  const bpmCandidate = Number(sanitized.bpm ?? controlsRaw.bpm);
  const bpm = Number.isFinite(bpmCandidate) && bpmCandidate > 0 ? bpmCandidate : 110;
  sanitized.bpm = bpm;
  if (controlsRaw.bpm === undefined) controlsRaw.bpm = bpm;
  if (Object.keys(controlsRaw).length > 0) sanitized.controls = controlsRaw;

  const explicitKey =
    (typeof sanitized.keySignature === "string" && sanitized.keySignature.trim()) ||
    (typeof sanitized.key_signature === "string" && sanitized.key_signature.trim()) ||
    "";
  sanitized.keySignature =
    explicitKey ||
    defaultKeyForGenre(
      genre,
      typeof sanitized.prompt === "string" ? sanitized.prompt : "",
    );

  // bars = round(seconds * bpm / 240) in 4/4; default length is 3:30.
  const secondsCandidate = Number(sanitized.durationSeconds);
  const targetSeconds =
    Number.isFinite(secondsCandidate) && secondsCandidate >= 10 ? secondsCandidate : 210;
  const barsCandidate = Number(sanitized.bars);
  sanitized.bars =
    Number.isFinite(barsCandidate) && barsCandidate > 0
      ? barsCandidate
      : Math.max(4, Math.min(256, Math.round((targetSeconds * bpm) / 240)));

  if (typeof sanitized.prompt !== "string" || !sanitized.prompt.trim()) {
    if (genre) sanitized.prompt = genre;
  }

  return sanitized;
}

/** Entanglement fraction above which the payload is quarantined (reactor reports ~0–0.1). */
function entanglementCeiling(): number {
  return Math.max(
    0.01,
    // Default 0.1: entropy alone maxes at ~0.0999 after dampening; quarantine is for
    // real suppression failures / contamination, not hash noise on clean composition.
    Number.parseFloat(process.env.DEEP_ISOLATION_ENTANGLEMENT_CEILING ?? "0.1") || 0.1,
  );
}

function maxNodeCapacity(): number {
  return Math.max(1, Number.parseInt(process.env.MAX_NODE_CAPACITY ?? "25", 10) || 25);
}

export class DeepIsolationPlacement {
  /**
   * Executes deep isolation processing, evaluates node saturation,
   * and computes the secure core placement destination with audit telemetry.
   */
  static async routeAndPlace(
    ctx: ExecutionContext,
    rawPayload: Record<string, unknown>,
  ): Promise<PlacementEnvelope> {
    // 0. Allowlist composition props only — never feed queue-row metadata to the reactor.
    const compositionPayload = sanitizeCompositionInput(rawPayload);

    // 1. Pass payload through the deep isolation detanglement reactor.
    // reactorNonce stays bound to ctx.sessionNonce (reactor_${sessionNonce}).
    const { sanitizedPayload, reactorState } = DetanglementReactor.purgeCrossCorrelations(
      ctx,
      compositionPayload,
    );

    // 2. Evaluate isolation integrity based on reactor metrics.
    const isCompromised =
      reactorState.entanglementLevel > entanglementCeiling() ||
      !reactorState.suppressionActive;

    if (isCompromised) {
      await DeepIsolationPlacement.logPlacementTelemetry(
        ctx,
        "QUARANTINED",
        "quarantine-isolation-node",
        reactorState,
      );
      return {
        targetClusterNode: "quarantine-isolation-node",
        isolationLevel: "MAXIMUM_SECURITY_STRIPPED",
        reactorNonce: reactorState.reactorNonce,
        sanitizedPayload: { error: "Payload failed deep isolation verification" },
        securityVerdict: "QUARANTINED",
        reactorState,
      };
    }

    // 3. Determine target node based on user tier.
    let targetNode =
      ctx.tier === "enterprise"
        ? "enterprise-isolated-grid-01"
        : "standard-worker-grid-pool";

    // 4. Edge-case safeguard: primary node cluster congestion → standby overflow.
    const isSaturated = await DeepIsolationPlacement.checkNodeSaturation(targetNode);
    if (isSaturated) {
      targetNode = "standby-overflow-grid-pool";
      await DeepIsolationPlacement.logPlacementTelemetry(
        ctx,
        "FALLBACK_ROUTED",
        targetNode,
        reactorState,
      );
      return {
        targetClusterNode: targetNode,
        isolationLevel: "ORTHOGONAL_SUPPRESSED_FALLBACK",
        reactorNonce: reactorState.reactorNonce,
        sanitizedPayload,
        securityVerdict: "FALLBACK_ROUTED",
        reactorState,
      };
    }

    // 5. Normal successful placement.
    await DeepIsolationPlacement.logPlacementTelemetry(
      ctx,
      "PASSED_ISOLATION",
      targetNode,
      reactorState,
    );
    return {
      targetClusterNode: targetNode,
      isolationLevel: "ORTHOGONAL_SUPPRESSED",
      reactorNonce: reactorState.reactorNonce,
      sanitizedPayload,
      securityVerdict: "PASSED_ISOLATION",
      reactorState,
    };
  }

  /**
   * Evaluates active node load against threshold constraints.
   */
  private static async checkNodeSaturation(nodeName: string): Promise<boolean> {
    try {
      const { tryGetSupabaseAdmin } = await import("@/integrations/supabase/client.server");
      const admin = tryGetSupabaseAdmin();
      if (!admin) return false;

      const { count: activeJobs, error } = await admin
        .from("generation_queue")
        .select("*", { count: "exact", head: true })
        .eq("status", "processing")
        .eq("assigned_node", nodeName);

      if (error) {
        console.warn("[DEEP ISOLATION] saturation probe failed", error.message);
        return false;
      }

      return (activeJobs ?? 0) >= maxNodeCapacity();
    } catch (err) {
      console.warn(
        "[DEEP ISOLATION] saturation probe failed",
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  /**
   * Writes placement telemetry audit records via Informant (never throws).
   */
  private static async logPlacementTelemetry(
    ctx: ExecutionContext,
    verdict: IsolationSecurityVerdict,
    node: string,
    reactor: ReactorCoreState,
  ): Promise<void> {
    const status =
      verdict === "QUARANTINED"
        ? "QUARANTINED"
        : verdict === "FALLBACK_ROUTED"
          ? "WARNING"
          : "SUCCESS";

    await TelemetryAlignment.recordEvent(ctx, {
      eventType: "DEEP_ISOLATION_PLACEMENT",
      status,
      details: {
        securityVerdict: verdict,
        targetNode: node,
        entanglementLevel: reactor.entanglementLevel,
        entropyScore: reactor.entropyScore,
        reactorNonce: reactor.reactorNonce,
        suppressionActive: reactor.suppressionActive,
        maxNodeCapacity: maxNodeCapacity(),
        systemActor: SYSTEM_ACTOR,
      },
    });
  }
}

/**
 * Worker dispatcher helper: deep-isolate, halt on quarantine, else return
 * the assigned secure cluster node + sanitized payload (including fallback).
 */
export async function dispatchToSecureCore(
  ctx: ExecutionContext,
  rawJobPayload: Record<string, unknown>,
): Promise<SecureCoreDispatch> {
  const placement = await DeepIsolationPlacement.routeAndPlace(ctx, rawJobPayload);

  if (placement.securityVerdict === "QUARANTINED") {
    throw new Error(
      `[SECURITY HALT] Payload quarantined at node ${placement.targetClusterNode} (Nonce: ${placement.reactorNonce})`,
    );
  }

  return {
    node: placement.targetClusterNode,
    payload: placement.sanitizedPayload,
    nonce: placement.reactorNonce,
    isolationLevel: placement.isolationLevel,
    securityVerdict: placement.securityVerdict,
    reactorState: placement.reactorState,
  };
}
