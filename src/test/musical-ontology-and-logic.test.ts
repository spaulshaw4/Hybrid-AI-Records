import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { MusicalOntologyAndLogicEngine } from "@/lib/MusicalOntologyAndLogicEngine";

describe("MusicalOntologyAndLogicEngine", () => {
  it("enforces thick classical score compliance with high thickness", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_phil", requestId: "req_phil_1" },
    );

    const thick = MusicalOntologyAndLogicEngine.evaluateMusicalLogic(ctx, {
      workType: "THICK_CLASSICAL_SCORE",
      listeningMode: "ARCHITECTONIC_LARGE_SCALE",
      expressiveValence: "TRAGIC_SADNESS",
    });

    expect(thick.ontologyEngineId).toMatch(/^phil_logic_nonce_phil_/);
    expect(thick.enforcedComplianceNorm).toBe("STRICT_SCORE_COMPLIANCE");
    expect(thick.ontologicalThicknessScore).toBe(0.95);
    expect(thick.expressiveContourMatchIndex).toBe(0.96); // 0.94 + architectonic boost
    expect(thick.structuralCoherenceVerdict).toBe("ONTOLOGICALLY_STABLE");
    expect(thick.philosophyCoherenceIndex).toBeGreaterThanOrEqual(0.96);
  });

  it("marks thin improvisational frameworks with interpretive integrity", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "aligned-runner",
      { sessionNonce: "nonce_thin" },
    );
    const thin = MusicalOntologyAndLogicEngine.evaluateMusicalLogic(ctx, {
      workType: "THIN_IMPROVISATIONAL_FRAMEWORK",
      listeningMode: "CONCATENATIONIST_MOMENT",
      expressiveValence: "EUPHORIC_JOY",
    });
    expect(thin.enforcedComplianceNorm).toBe("INTERPRETIVE_INTEGRITY_TRUMPS_SCORE");
    expect(thin.ontologicalThicknessScore).toBe(0.45);
    expect(thin.structuralCoherenceVerdict).toBe("ONTOLOGICALLY_STABLE");
  });

  it("maps Seattle archetype to recording-determined rock", () => {
    const derived = MusicalOntologyAndLogicEngine.derivePhilosophyLogicInput({
      genreArchetype: "SEATTLE_90S_WALL_OF_SOUND",
      lyricSegments: [
        {
          sectionName: "VERSE",
          lyricSnippet: "quiet rooms",
          emotionalValence: "MELANCHOLIC",
          syllableDensityPerBar: 6,
        },
      ],
    });
    expect(derived.workType).toBe("RECORDING_DETERMINED_ROCK");
    expect(derived.expressiveValence).toBe("TRAGIC_SADNESS");
    expect(derived.listeningMode).toBe("CONCATENATIONIST_MOMENT");
  });

  it("uses CTX-seeded philosophy coherence (deterministic)", () => {
    const a = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same_p", requestId: "req_same_p" },
    );
    const b = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same_p", requestId: "req_same_p" },
    );
    const input = {
      workType: "RECORDING_DETERMINED_ROCK" as const,
      listeningMode: "CONCATENATIONIST_MOMENT" as const,
      expressiveValence: "TENSE_NEUTRAL" as const,
    };
    expect(
      MusicalOntologyAndLogicEngine.evaluateMusicalLogic(a, input).philosophyCoherenceIndex,
    ).toBe(
      MusicalOntologyAndLogicEngine.evaluateMusicalLogic(b, input).philosophyCoherenceIndex,
    );
    const source = readFileSync(
      join(process.cwd(), "src/lib/MusicalOntologyAndLogicEngine.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random\s*\(/);
  });

  it("is wired after classical theory and before lyric in MasterPipelineRunner", () => {
    const master = readFileSync(
      join(process.cwd(), "src/lib/MasterPipelineRunner.ts"),
      "utf8",
    );
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const theoryIdx = master.indexOf("ClassicalTheoryEngine.deriveClassicalHarmonics");
    const philIdx = master.indexOf("MusicalOntologyAndLogicEngine.evaluateMusicalLogic");
    const lyricIdx = master.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    expect(philIdx).toBeGreaterThan(theoryIdx);
    expect(lyricIdx).toBeGreaterThan(philIdx);
    expect(master).toContain("philosophyBlueprint");
    expect(worker).toContain("musicalOntologyAndLogic");
  });
});
