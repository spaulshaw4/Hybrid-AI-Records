/**
 * Musical Philosophy & Logic Engine — ontology, compliance norms, expressive contour.
 *
 * After Classical Theory establishes tonal architecture, this engine enforces
 * work-ontology thickness (score vs improvisation vs recording-as-work), Dodd-style
 * compliance norms, and resemblance/contour expressive authenticity before
 * Style & Lyric / vocal layers interpret the piece.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";
import type { MusicalInfluenceArchetype } from "@/lib/StyleInfluenceEnlightment";
import type { LyricSegmentInput, EmotionalValence } from "@/lib/StyleLyricEnlinement";

export type WorkOntologyType =
  | "THICK_CLASSICAL_SCORE"
  | "THIN_IMPROVISATIONAL_FRAMEWORK"
  | "RECORDING_DETERMINED_ROCK";

export type ListeningPerspective =
  | "CONCATENATIONIST_MOMENT"
  | "ARCHITECTONIC_LARGE_SCALE";

export type ExpressiveValence = "TRAGIC_SADNESS" | "EUPHORIC_JOY" | "TENSE_NEUTRAL";

export type PhilosophyLogicInput = {
  workType: WorkOntologyType;
  listeningMode: ListeningPerspective;
  expressiveValence: ExpressiveValence;
};

export type StructuralCoherenceVerdict =
  | "ONTOLOGICALLY_STABLE"
  | "REQUIRES_CONTEXT_ANCHOR";

export type PhilosophyLogicBlueprint = {
  ontologyEngineId: string;
  enforcedComplianceNorm: string;
  ontologicalThicknessScore: number;
  expressiveContourMatchIndex: number;
  structuralCoherenceVerdict: StructuralCoherenceVerdict;
  /** CTX-seeded audit fingerprint for ontology evaluation. */
  philosophyCoherenceIndex: number;
};

export class MusicalOntologyAndLogicEngine {
  /**
   * Translates music ontology and expressiveness theory into code,
   * enforcing score compliance, structural perspective, and expressive contour rules.
   */
  static evaluateMusicalLogic(
    ctx: ExecutionContext,
    input: PhilosophyLogicInput,
  ): PhilosophyLogicBlueprint {
    const ontologyEngineId = `phil_logic_${ctx.sessionNonce}_${Date.now()}`;

    // Ontological thickness and compliance norms based on work type
    let complianceNorm = "STRICT_SCORE_COMPLIANCE";
    let thicknessScore = 0.95;
    if (input.workType === "THIN_IMPROVISATIONAL_FRAMEWORK") {
      complianceNorm = "INTERPRETIVE_INTEGRITY_TRUMPS_SCORE";
      thicknessScore = 0.45;
    } else if (input.workType === "RECORDING_DETERMINED_ROCK") {
      complianceNorm = "RECORDING_AS_WORK_INSTANCE";
      thicknessScore = 0.75;
    }

    // Expressive contour index (resemblance / contour theory + listener perspective)
    let contourMatch = 0.88;
    if (input.expressiveValence === "TRAGIC_SADNESS") {
      contourMatch = 0.94;
    } else if (input.expressiveValence === "EUPHORIC_JOY") {
      contourMatch = 0.91;
    } else if (input.expressiveValence === "TENSE_NEUTRAL") {
      contourMatch = 0.86;
    }

    // Architectonic listening slightly boosts large-scale contour fidelity.
    if (input.listeningMode === "ARCHITECTONIC_LARGE_SCALE") {
      contourMatch = Number(Math.min(0.99, contourMatch + 0.02).toFixed(4));
    }

    const structuralCoherenceVerdict: StructuralCoherenceVerdict =
      thicknessScore > 0.4 ? "ONTOLOGICALLY_STABLE" : "REQUIRES_CONTEXT_ANCHOR";

    return {
      ontologyEngineId,
      enforcedComplianceNorm: complianceNorm,
      ontologicalThicknessScore: thicknessScore,
      expressiveContourMatchIndex: Number(contourMatch.toFixed(4)),
      structuralCoherenceVerdict,
      philosophyCoherenceIndex: MusicalOntologyAndLogicEngine.computeCoherenceIndex(
        ctx,
        input,
        thicknessScore,
      ),
    };
  }

  /**
   * Derive ontology inputs from influence archetype, lyric valence, and payload hints.
   */
  static derivePhilosophyLogicInput(input: {
    genreArchetype?: MusicalInfluenceArchetype | null;
    lyricSegments?: LyricSegmentInput[];
    workTypeHint?: unknown;
    listeningModeHint?: unknown;
    expressiveValenceHint?: unknown;
    genreHint?: unknown;
  }): PhilosophyLogicInput {
    const workType =
      MusicalOntologyAndLogicEngine.tryParseWorkType(input.workTypeHint) ||
      MusicalOntologyAndLogicEngine.workTypeFromArchetype(
        input.genreArchetype,
        input.genreHint,
      );

    const listeningMode =
      MusicalOntologyAndLogicEngine.tryParseListeningMode(input.listeningModeHint) ||
      (workType === "THICK_CLASSICAL_SCORE"
        ? "ARCHITECTONIC_LARGE_SCALE"
        : "CONCATENATIONIST_MOMENT");

    const expressiveValence =
      MusicalOntologyAndLogicEngine.tryParseExpressiveValence(input.expressiveValenceHint) ||
      MusicalOntologyAndLogicEngine.valenceFromLyricSegments(input.lyricSegments);

    return { workType, listeningMode, expressiveValence };
  }

  static workTypeFromArchetype(
    archetype?: MusicalInfluenceArchetype | null,
    genreHint?: unknown,
  ): WorkOntologyType {
    const genre = String(genreHint ?? "").toLowerCase();
    if (/jazz|improv|freeform|session/.test(genre)) {
      return "THIN_IMPROVISATIONAL_FRAMEWORK";
    }
    if (/classical|orchestral|score|symphony/.test(genre)) {
      return "THICK_CLASSICAL_SCORE";
    }
    switch (archetype) {
      case "SEATTLE_90S_WALL_OF_SOUND":
      case "DETROIT_INDUSTRIAL_GRIT":
      case "BRITISH_POST_PUNK_TENSE":
      case "MODERN_TRAP_METAL_HYBRID":
        return "RECORDING_DETERMINED_ROCK";
      default:
        return "RECORDING_DETERMINED_ROCK";
    }
  }

  static valenceFromLyricSegments(segments?: LyricSegmentInput[]): ExpressiveValence {
    const list = Array.isArray(segments) ? segments : [];
    if (list.length === 0) return "TENSE_NEUTRAL";

    const scores: Record<ExpressiveValence, number> = {
      TRAGIC_SADNESS: 0,
      EUPHORIC_JOY: 0,
      TENSE_NEUTRAL: 0,
    };
    for (const seg of list) {
      scores[mapLyricValence(seg.emotionalValence)] += 1;
    }
    return (Object.entries(scores) as [ExpressiveValence, number][]).sort(
      (a, b) => b[1] - a[1],
    )[0][0];
  }

  static tryParseWorkType(raw: unknown): WorkOntologyType | null {
    const s = String(raw ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (
      s === "THICK_CLASSICAL_SCORE" ||
      s === "THIN_IMPROVISATIONAL_FRAMEWORK" ||
      s === "RECORDING_DETERMINED_ROCK"
    ) {
      return s;
    }
    return null;
  }

  static tryParseListeningMode(raw: unknown): ListeningPerspective | null {
    const s = String(raw ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (s === "CONCATENATIONIST_MOMENT" || s === "ARCHITECTONIC_LARGE_SCALE") {
      return s;
    }
    return null;
  }

  static tryParseExpressiveValence(raw: unknown): ExpressiveValence | null {
    const s = String(raw ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (s === "TRAGIC_SADNESS" || s === "EUPHORIC_JOY" || s === "TENSE_NEUTRAL") {
      return s;
    }
    return null;
  }

  /** Deterministic coherence in ~0.96–0.99 from CTX + ontology fingerprints. */
  static computeCoherenceIndex(
    ctx: ExecutionContext,
    input: PhilosophyLogicInput,
    thicknessScore: number,
  ): number {
    const hash = algorithmicHash32(
      `${ctx.requestId}|${ctx.sessionNonce}|phil_logic|${input.workType}|${input.listeningMode}|${input.expressiveValence}|${thicknessScore}`,
    );
    const jitter = (hash % 30) / 1000; // 0.000–0.029
    return Number((0.96 + jitter).toFixed(4));
  }
}

function mapLyricValence(v: EmotionalValence): ExpressiveValence {
  switch (v) {
    case "MELANCHOLIC":
    case "INTROSPECTIVE":
      return "TRAGIC_SADNESS";
    case "TRIUMPHANT":
      return "EUPHORIC_JOY";
    case "AGGRESSIVE":
    default:
      return "TENSE_NEUTRAL";
  }
}
