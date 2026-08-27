/**
 * Classical Music Theory Engine — deterministic Western tonal architecture.
 *
 * After BPM + Logical Rhythm establish meter/groove, this engine blueprints the
 * tonic, mode, semitone ladder, and diatonic triads (roman + quality + stacked
 * notes) before Style & Lyric / vocal layers inherit legally sound harmony.
 */

import type { ExecutionContext } from "@/lib/ExecutionContext";
import { algorithmicHash32 } from "@/lib/FluctuatorEngine";
import type { MusicalInfluenceArchetype } from "@/lib/StyleInfluenceEnlightment";

export type ScaleMode =
  | "IONIAN"
  | "DORIAN"
  | "PHRYGIAN"
  | "LYDIAN"
  | "MIXOLYDIAN"
  | "AEOLIAN"
  | "LOCRIAN";

export type TriadQuality = "MAJOR" | "MINOR" | "DIMINISHED" | "AUGMENTED";

export type DiatonicTriad = {
  degree: string;
  roman: string;
  quality: TriadQuality;
  notes: string[];
};

export type TheoryBlueprint = {
  theoryEngineId: string;
  tonicNote: string;
  mode: ScaleMode;
  semitonePattern: number[];
  diatonicTriads: DiatonicTriad[];
  theoryCoherenceIndex: number;
};

/** Tone = 2, Semitone = 1 — standard diatonic mode offsets. */
const MODE_OFFSETS: Record<ScaleMode, number[]> = {
  IONIAN: [2, 2, 1, 2, 2, 2, 1],
  DORIAN: [2, 1, 2, 2, 2, 1, 2],
  PHRYGIAN: [1, 2, 2, 2, 1, 2, 2],
  LYDIAN: [2, 2, 2, 1, 2, 2, 1],
  MIXOLYDIAN: [2, 2, 1, 2, 2, 1, 2],
  AEOLIAN: [2, 1, 2, 2, 1, 2, 2],
  LOCRIAN: [1, 2, 2, 1, 2, 2, 2],
};

const CHROMATIC = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
] as const;

const NOTE_ALIASES: Record<string, string> = {
  DB: "C#",
  EB: "D#",
  FB: "E",
  GB: "F#",
  AB: "G#",
  BB: "A#",
  CB: "B",
  "E#": "F",
  "B#": "C",
};

const DEGREE_ROMANS = ["I", "II", "III", "IV", "V", "VI", "VII"] as const;

export class ClassicalTheoryEngine {
  /**
   * Generates deterministic classical scales, intervals, and functional harmonic
   * triads based on the foundational rules of Western tonal architecture.
   */
  static deriveClassicalHarmonics(
    ctx: ExecutionContext,
    tonic: string,
    mode: ScaleMode,
  ): TheoryBlueprint {
    const theoryEngineId = `theory_engine_${ctx.sessionNonce}_${Date.now()}`;
    const resolvedMode = ClassicalTheoryEngine.normalizeMode(mode);
    const tonicNote = ClassicalTheoryEngine.normalizeTonic(tonic);
    const semitonePattern = MODE_OFFSETS[resolvedMode];

    const scaleNotes = ClassicalTheoryEngine.buildScaleNotes(tonicNote, semitonePattern);
    const diatonicTriads = ClassicalTheoryEngine.buildDiatonicTriads(scaleNotes);

    return {
      theoryEngineId,
      tonicNote,
      mode: resolvedMode,
      semitonePattern: [...semitonePattern],
      diatonicTriads,
      theoryCoherenceIndex: ClassicalTheoryEngine.computeCoherenceIndex(
        ctx,
        tonicNote,
        resolvedMode,
      ),
    };
  }

  /**
   * Resolve tonic + mode from influence archetype / studio payload when not
   * supplied explicitly.
   */
  static deriveTonicAndMode(input: {
    genreArchetype?: MusicalInfluenceArchetype | null;
    tonicHint?: unknown;
    modeHint?: unknown;
    keyHint?: unknown;
    genreHint?: unknown;
  }): { tonic: string; mode: ScaleMode } {
    const fromMode = ClassicalTheoryEngine.tryParseMode(input.modeHint);
    const fromTonic =
      ClassicalTheoryEngine.tryParseTonic(input.tonicHint) ||
      ClassicalTheoryEngine.tryParseTonic(input.keyHint);

    if (fromTonic && fromMode) {
      return { tonic: fromTonic, mode: fromMode };
    }

    const archetypeDefaults: Record<
      MusicalInfluenceArchetype,
      { tonic: string; mode: ScaleMode }
    > = {
      SEATTLE_90S_WALL_OF_SOUND: { tonic: "E", mode: "AEOLIAN" },
      DETROIT_INDUSTRIAL_GRIT: { tonic: "A", mode: "PHRYGIAN" },
      BRITISH_POST_PUNK_TENSE: { tonic: "D", mode: "DORIAN" },
      MODERN_TRAP_METAL_HYBRID: { tonic: "F#", mode: "LOCRIAN" },
    };

    const archetype = input.genreArchetype;
    if (archetype && archetypeDefaults[archetype]) {
      return {
        tonic: fromTonic || archetypeDefaults[archetype].tonic,
        mode: fromMode || archetypeDefaults[archetype].mode,
      };
    }

    const genre = String(input.genreHint ?? "").toLowerCase();
    if (/jazz|fusion/.test(genre)) {
      return { tonic: fromTonic || "F", mode: fromMode || "DORIAN" };
    }
    if (/blues|rock|metal|grunge/.test(genre)) {
      return { tonic: fromTonic || "E", mode: fromMode || "AEOLIAN" };
    }
    if (/pop|dance|house|electronic/.test(genre)) {
      return { tonic: fromTonic || "C", mode: fromMode || "IONIAN" };
    }

    return { tonic: fromTonic || "C", mode: fromMode || "IONIAN" };
  }

  static buildScaleNotes(tonic: string, semitonePattern: number[]): string[] {
    const tonicPc = pitchClassIndex(tonic);
    const notes: string[] = [CHROMATIC[tonicPc]];
    let cursor = tonicPc;
    // Apply first 6 intervals to produce degrees 2–7 (7th closes the octave).
    for (let i = 0; i < 6; i++) {
      cursor = (cursor + semitonePattern[i]) % 12;
      notes.push(CHROMATIC[cursor]);
    }
    return notes;
  }

  static buildDiatonicTriads(scaleNotes: string[]): DiatonicTriad[] {
    const degrees = scaleNotes.length >= 7 ? scaleNotes.slice(0, 7) : scaleNotes;
    return degrees.map((_, index) => {
      const root = degrees[index];
      const third = degrees[(index + 2) % 7];
      const fifth = degrees[(index + 4) % 7];
      const quality = triadQualityFromIntervals(root, third, fifth);
      const roman = romanForDegree(index, quality);
      return {
        degree: `Scale_Degree_${index + 1}`,
        roman,
        quality,
        notes: [root, third, fifth],
      };
    });
  }

  static normalizeMode(mode: ScaleMode | string): ScaleMode {
    return ClassicalTheoryEngine.tryParseMode(mode) || "IONIAN";
  }

  static normalizeTonic(tonic: string): string {
    return ClassicalTheoryEngine.tryParseTonic(tonic) || "C";
  }

  static tryParseMode(raw: unknown): ScaleMode | null {
    const s = String(raw ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "_");
    if (!s) return null;
    if (s === "MAJOR" || s === "MAJ") return "IONIAN";
    if (s === "MINOR" || s === "MIN" || s === "NATURAL_MINOR") return "AEOLIAN";
    if ((Object.keys(MODE_OFFSETS) as ScaleMode[]).includes(s as ScaleMode)) {
      return s as ScaleMode;
    }
    return null;
  }

  static tryParseTonic(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const cleaned = raw.trim().toUpperCase().replace(/\s+/g, "");
    if (!cleaned) return null;
    const match = cleaned.match(/^([A-G])([#B]?)/);
    if (!match) return null;
    const letter = match[1];
    const accidental = match[2] || "";
    if (accidental === "B") {
      return NOTE_ALIASES[`${letter}B`] || null;
    }
    const note = accidental === "#" ? `${letter}#` : letter;
    return CHROMATIC.includes(note as (typeof CHROMATIC)[number]) ? note : null;
  }

  /** Deterministic coherence in ~0.985–0.999 from CTX + tonic/mode. */
  static computeCoherenceIndex(
    ctx: ExecutionContext,
    tonic: string,
    mode: ScaleMode,
  ): number {
    const hash = algorithmicHash32(
      `${ctx.requestId}|${ctx.sessionNonce}|classical_theory|${tonic}|${mode}`,
    );
    const jitter = (hash % 15) / 1000; // 0.000–0.014
    return Number((0.985 + jitter).toFixed(4));
  }
}

function pitchClassIndex(note: string): number {
  const n = ClassicalTheoryEngine.normalizeTonic(note);
  const idx = CHROMATIC.indexOf(n as (typeof CHROMATIC)[number]);
  return idx >= 0 ? idx : 0;
}

function intervalSemitones(from: string, to: string): number {
  const a = pitchClassIndex(from);
  const b = pitchClassIndex(to);
  return (b - a + 12) % 12;
}

function triadQualityFromIntervals(
  root: string,
  third: string,
  fifth: string,
): TriadQuality {
  const thirdSpan = intervalSemitones(root, third);
  const fifthSpan = intervalSemitones(root, fifth);
  if (thirdSpan === 4 && fifthSpan === 7) return "MAJOR";
  if (thirdSpan === 3 && fifthSpan === 7) return "MINOR";
  if (thirdSpan === 3 && fifthSpan === 6) return "DIMINISHED";
  if (thirdSpan === 4 && fifthSpan === 8) return "AUGMENTED";
  // Fallback for exotic spellings
  if (fifthSpan === 6) return "DIMINISHED";
  if (fifthSpan === 8) return "AUGMENTED";
  if (thirdSpan === 3) return "MINOR";
  return "MAJOR";
}

function romanForDegree(index: number, quality: TriadQuality): string {
  const base = DEGREE_ROMANS[index] || `DEG_${index + 1}`;
  if (quality === "MINOR" || quality === "DIMINISHED") {
    const lower = base.toLowerCase();
    return quality === "DIMINISHED" ? `${lower}°` : lower;
  }
  if (quality === "AUGMENTED") return `${base}+`;
  return base;
}
