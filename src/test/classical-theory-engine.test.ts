import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { ClassicalTheoryEngine } from "@/lib/ClassicalTheoryEngine";

describe("ClassicalTheoryEngine", () => {
  it("builds C Ionian diatonic triads with functional roman numerals", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_theory", requestId: "req_theory_1" },
    );

    const theory = ClassicalTheoryEngine.deriveClassicalHarmonics(ctx, "C", "IONIAN");

    expect(theory.theoryEngineId).toMatch(/^theory_engine_nonce_theory_/);
    expect(theory.tonicNote).toBe("C");
    expect(theory.mode).toBe("IONIAN");
    expect(theory.semitonePattern).toEqual([2, 2, 1, 2, 2, 2, 1]);
    expect(theory.diatonicTriads).toHaveLength(7);
    expect(theory.diatonicTriads.map((t) => t.roman)).toEqual([
      "I",
      "ii",
      "iii",
      "IV",
      "V",
      "vi",
      "vii°",
    ]);
    expect(theory.diatonicTriads[0].notes).toEqual(["C", "E", "G"]);
    expect(theory.diatonicTriads[4].notes).toEqual(["G", "B", "D"]);
    expect(theory.diatonicTriads[6].quality).toBe("DIMINISHED");
    expect(theory.theoryCoherenceIndex).toBeGreaterThanOrEqual(0.985);
    expect(theory.theoryCoherenceIndex).toBeLessThanOrEqual(0.999);
  });

  it("builds E Aeolian (natural minor) with correct qualities", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "master-pipeline-runner",
      { sessionNonce: "nonce_aeolian", requestId: "req_aeolian" },
    );
    const theory = ClassicalTheoryEngine.deriveClassicalHarmonics(ctx, "E", "AEOLIAN");
    expect(theory.diatonicTriads.map((t) => t.quality)).toEqual([
      "MINOR",
      "DIMINISHED",
      "MAJOR",
      "MINOR",
      "MINOR",
      "MAJOR",
      "MAJOR",
    ]);
    expect(theory.diatonicTriads[0].notes).toEqual(["E", "G", "B"]);
  });

  it("uses CTX-seeded coherence (deterministic)", () => {
    const a = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "aligned-runner",
      { sessionNonce: "nonce_same_t", requestId: "req_same_t" },
    );
    const b = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "aligned-runner",
      { sessionNonce: "nonce_same_t", requestId: "req_same_t" },
    );
    expect(ClassicalTheoryEngine.deriveClassicalHarmonics(a, "A", "DORIAN").theoryCoherenceIndex).toBe(
      ClassicalTheoryEngine.deriveClassicalHarmonics(b, "A", "DORIAN").theoryCoherenceIndex,
    );
    const source = readFileSync(
      join(process.cwd(), "src/lib/ClassicalTheoryEngine.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).toContain("algorithmicHash32");
  });

  it("derives tonic/mode from Seattle archetype", () => {
    const derived = ClassicalTheoryEngine.deriveTonicAndMode({
      genreArchetype: "SEATTLE_90S_WALL_OF_SOUND",
    });
    expect(derived).toEqual({ tonic: "E", mode: "AEOLIAN" });
  });

  it("is wired after logical rhythm and before lyric in MasterPipelineRunner", () => {
    const master = readFileSync(
      join(process.cwd(), "src/lib/MasterPipelineRunner.ts"),
      "utf8",
    );
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const rhythmIdx = master.indexOf("LogicalRhythmEnlinement.enlineLogicalRhythm");
    const theoryIdx = master.indexOf("ClassicalTheoryEngine.deriveClassicalHarmonics");
    const lyricIdx = master.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    expect(theoryIdx).toBeGreaterThan(rhythmIdx);
    expect(lyricIdx).toBeGreaterThan(theoryIdx);
    expect(master).toContain("theoryBlueprint");
    expect(worker).toContain("classicalTheoryEngine");
  });
});
