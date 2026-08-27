/**
 * Genre Entitlement Placement — stylistic DNA gate before music alignment.
 *
 * Verifies BPM / genre entitlement profiles (heavy alt, nu-metal, rap-rock,
 * amapiano) before dismantel / structure / decompression burn render budget.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";

export type SupportedGenre =
  | "HEAVY_ALTERNATIVE_ROCK"
  | "NU_METAL"
  | "RAP_ROCK"
  | "AMAPIANO";

export type SubBassRouting = "MONO_LOCKED" | "SIDECHAIN_COMPRESSED" | "WIDE_SUB";
export type DistortionProfile =
  | "TAPE_SATURATION"
  | "TUBE_WARMTH"
  | "DIODE_CLIP"
  | "CLEAN";

export type GenreEntitlementRule = {
  genre: SupportedGenre;
  requiredBpmRange: [number, number];
  subBassRouting: SubBassRouting;
  distortionProfile: DistortionProfile;
  masterLufsTarget: number;
};

export type EntitlementStatus = "PASSED_ENTITLEMENT" | "GENRE_MISMATCH_QUARANTINED";

export type EntitlementVerificationResult = {
  entitlementId: string;
  genreVerified: SupportedGenre;
  appliedRules: GenreEntitlementRule;
  entitlementStatus: EntitlementStatus;
  currentBpm: number;
};

const ENTITLEMENT_PROFILES: Record<SupportedGenre, GenreEntitlementRule> = {
  HEAVY_ALTERNATIVE_ROCK: {
    genre: "HEAVY_ALTERNATIVE_ROCK",
    requiredBpmRange: [110, 145],
    subBassRouting: "MONO_LOCKED",
    distortionProfile: "TUBE_WARMTH",
    masterLufsTarget: -9.5,
  },
  NU_METAL: {
    genre: "NU_METAL",
    requiredBpmRange: [95, 130],
    subBassRouting: "MONO_LOCKED",
    distortionProfile: "DIODE_CLIP",
    masterLufsTarget: -9.0,
  },
  RAP_ROCK: {
    genre: "RAP_ROCK",
    requiredBpmRange: [85, 120],
    subBassRouting: "SIDECHAIN_COMPRESSED",
    distortionProfile: "TAPE_SATURATION",
    masterLufsTarget: -10.0,
  },
  AMAPIANO: {
    genre: "AMAPIANO",
    requiredBpmRange: [110, 115],
    subBassRouting: "MONO_LOCKED",
    distortionProfile: "CLEAN",
    masterLufsTarget: -11.5,
  },
};

export class GenreEntitlementPlacement {
  /**
   * Verifies and enforces genre-specific sonic entitlement rules, ensuring
   * stems and arrangement blueprints match the stylistic DNA of the track.
   */
  static verifyAndEnforceEntitlement(
    ctx: ExecutionContext,
    targetGenre: SupportedGenre,
    currentBpm: number,
  ): EntitlementVerificationResult {
    const entitlementId = `entitlement_${ctx.sessionNonce}_${Date.now()}`;
    const rule = ENTITLEMENT_PROFILES[targetGenre];
    const bpm = Number.isFinite(currentBpm) ? currentBpm : 0;
    const isBpmValid = bpm >= rule.requiredBpmRange[0] && bpm <= rule.requiredBpmRange[1];

    return {
      entitlementId,
      genreVerified: targetGenre,
      appliedRules: rule,
      entitlementStatus: isBpmValid ? "PASSED_ENTITLEMENT" : "GENRE_MISMATCH_QUARANTINED",
      currentBpm: bpm,
    };
  }

  /** Map free-text genre / style / prompt hints onto a SupportedGenre. */
  static resolveSupportedGenre(raw: unknown, fallback: SupportedGenre = "HEAVY_ALTERNATIVE_ROCK"): SupportedGenre {
    const text = String(raw ?? "")
      .toLowerCase()
      .replace(/[_-]+/g, " ")
      .trim();
    if (!text) return fallback;
    if (/amapiano|log drum|piano house/.test(text)) return "AMAPIANO";
    if (/nu\s*metal|numetal|korn|deftones/.test(text)) return "NU_METAL";
    if (/rap\s*rock|raprock|rage rock|hybrid rap/.test(text)) return "RAP_ROCK";
    if (/alternative|alt rock|heavy rock|grunge|hard rock/.test(text)) {
      return "HEAVY_ALTERNATIVE_ROCK";
    }
    if (/metal/.test(text)) return "NU_METAL";
    if (/rap|hip\s*hop/.test(text)) return "RAP_ROCK";
    return fallback;
  }

  /** Resolve BPM from controls / payload with a genre-sane default mid-range. */
  static resolveBpm(
    raw: unknown,
    genre: SupportedGenre,
  ): number {
    const n =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number.parseFloat(raw)
          : NaN;
    if (Number.isFinite(n) && n > 40 && n < 240) return Math.round(n);
    const [lo, hi] = ENTITLEMENT_PROFILES[genre].requiredBpmRange;
    return Math.round((lo + hi) / 2);
  }

  static getEntitlementProfiles(): Record<SupportedGenre, GenreEntitlementRule> {
    return { ...ENTITLEMENT_PROFILES };
  }
}
