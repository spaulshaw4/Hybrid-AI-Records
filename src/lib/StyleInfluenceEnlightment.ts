/**
 * Style Influence Enlightment — legendary production archetypes → mix profiles.
 *
 * Translates stylistic lineage (Seattle wall-of-sound, Detroit industrial, etc.)
 * into EQ cuts, tube saturation, reverb tails, and transient smear for the
 * downstream music alignment chain.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";
import type { SupportedGenre } from "@/lib/GenreEntitlementPlacement";

export type MusicalInfluenceArchetype =
  | "SEATTLE_90S_WALL_OF_SOUND"
  | "DETROIT_INDUSTRIAL_GRIT"
  | "BRITISH_POST_PUNK_TENSE"
  | "MODERN_TRAP_METAL_HYBRID";

export type InfluenceBlueprint = {
  influenceBlueprintId: string;
  archetype: MusicalInfluenceArchetype;
  sonicSignatures: {
    midRangeBoxinessCutDb: number;
    harmonicTubeSaturationLevel: number;
    reverbDecaySeconds: number;
    transientSmearFactor: number;
  };
  enlightmentCoherenceScore: number;
};

const INFLUENCE_PROFILES: Record<
  MusicalInfluenceArchetype,
  { cut: number; sat: number; verb: number; smear: number }
> = {
  SEATTLE_90S_WALL_OF_SOUND: {
    cut: -2.5,
    sat: 6.8,
    verb: 2.4,
    smear: 0.35,
  },
  DETROIT_INDUSTRIAL_GRIT: {
    cut: -1.2,
    sat: 9.5,
    verb: 4.1,
    smear: 0.15,
  },
  BRITISH_POST_PUNK_TENSE: {
    cut: -3.0,
    sat: 3.4,
    verb: 1.2,
    smear: 0.5,
  },
  MODERN_TRAP_METAL_HYBRID: {
    cut: -2.0,
    sat: 7.5,
    verb: 3.0,
    smear: 0.2,
  },
};

export class StyleInfluenceEnlightment {
  /**
   * Translates legendary production archetypes and stylistic lineage into
   * actionable mixing profiles, saturation curves, and acoustic space parameters.
   */
  static enlighteneStyleInfluence(
    ctx: ExecutionContext,
    archetype: MusicalInfluenceArchetype,
  ): InfluenceBlueprint {
    const influenceBlueprintId = `influence_${ctx.sessionNonce}_${Date.now()}`;
    const profile = INFLUENCE_PROFILES[archetype];

    return {
      influenceBlueprintId,
      archetype,
      sonicSignatures: {
        midRangeBoxinessCutDb: profile.cut,
        harmonicTubeSaturationLevel: profile.sat,
        reverbDecaySeconds: profile.verb,
        transientSmearFactor: profile.smear,
      },
      enlightmentCoherenceScore: StyleInfluenceEnlightment.computeCoherenceScore(
        ctx,
        archetype,
      ),
    };
  }

  /** Map genre entitlement / free-text hints onto a production archetype. */
  static resolveArchetype(input: {
    genre?: SupportedGenre | string;
    styleHint?: unknown;
    promptHint?: unknown;
  }): MusicalInfluenceArchetype {
    const genre = String(input.genre ?? "").toUpperCase();
    const text = `${input.styleHint ?? ""} ${input.promptHint ?? ""}`.toLowerCase();

    if (genre === "NU_METAL" || /trap metal|nu metal|djent/.test(text)) {
      return "MODERN_TRAP_METAL_HYBRID";
    }
    if (genre === "RAP_ROCK" || /industrial|detroit|nine inch|ministry/.test(text)) {
      return "DETROIT_INDUSTRIAL_GRIT";
    }
    if (/post.?punk|british|joy division|cure|goth/.test(text)) {
      return "BRITISH_POST_PUNK_TENSE";
    }
    if (
      genre === "HEAVY_ALTERNATIVE_ROCK" ||
      /seattle|grunge|nirvana|soundgarden|wall of sound/.test(text)
    ) {
      return "SEATTLE_90S_WALL_OF_SOUND";
    }
    if (genre === "AMAPIANO" || /amapiano|afro house/.test(text)) {
      // Closest hybrid lineage for modern rhythmic saturation without industrial grit.
      return "MODERN_TRAP_METAL_HYBRID";
    }
    return "SEATTLE_90S_WALL_OF_SOUND";
  }

  /** Deterministic coherence in ~0.95–1.00 from CTX + archetype. */
  static computeCoherenceScore(
    ctx: ExecutionContext,
    archetype: MusicalInfluenceArchetype,
  ): number {
    const hash = algorithmicHash32(
      `${ctx.requestId}|${ctx.sessionNonce}|influence|${archetype}`,
    );
    const jitter = (hash % 50) / 1000; // 0.000–0.049
    return Number((0.95 + jitter).toFixed(4));
  }
}
