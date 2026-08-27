import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { BpmEnlinement } from "@/lib/BpmEnlinement";
import { LogicalRhythmEnlinement } from "@/lib/LogicalRhythmEnlinement";

describe("LogicalRhythmEnlinement", () => {
  it("builds 4/4 backbeat accents and scales swing with syncopation", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_rhythm", requestId: "req_rhythm_1" },
    );

    const straight = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, {
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      syncopationThreshold: 0,
    });
    const pushed = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, {
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      syncopationThreshold: 0.75,
    });

    expect(straight.rhythmBlueprintId).toMatch(/^rhythm_enline_nonce_rhythm_/);
    expect(straight.subdivisionHierarchy).toEqual([
      "quarter-note",
      "eighth-note",
      "sixteenth-note",
    ]);
    expect(straight.accentPositions).toEqual([2, 4]);
    expect(straight.swingFactor).toBe(0);
    expect(pushed.swingFactor).toBe(0.18);
    expect(pushed.rhythmCoherenceScore).toBeGreaterThanOrEqual(0.97);
    expect(pushed.rhythmCoherenceScore).toBeLessThanOrEqual(0.995);
  });

  it("uses compound hierarchy for 6/* meters", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "aligned-runner",
      { sessionNonce: "nonce_6_8" },
    );
    const six = LogicalRhythmEnlinement.enlineLogicalRhythm(ctx, {
      timeSignatureNumerator: 6,
      timeSignatureDenominator: 8,
      syncopationThreshold: 0.4,
    });
    expect(six.subdivisionHierarchy).toEqual(["dotted-quarter", "eighth-note"]);
    expect(six.accentPositions).toEqual([1, 4]);
  });

  it("uses CTX-seeded coherence (deterministic)", () => {
    const a = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same_r", requestId: "req_same_r" },
    );
    const b = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "master-pipeline-runner",
      { sessionNonce: "nonce_same_r", requestId: "req_same_r" },
    );
    const input = {
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      syncopationThreshold: 0.42,
    };
    expect(LogicalRhythmEnlinement.enlineLogicalRhythm(a, input).rhythmCoherenceScore).toBe(
      LogicalRhythmEnlinement.enlineLogicalRhythm(b, input).rhythmCoherenceScore,
    );

    const source = readFileSync(
      join(process.cwd(), "src/lib/LogicalRhythmEnlinement.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/Math\.random\s*\(/);
    expect(source).toContain("algorithmicHash32");
  });

  it("derives pattern from BPM blueprint + chaos", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { sessionNonce: "nonce_derive_r", requestId: "req_derive_r" },
    );
    const bpm = BpmEnlinement.enlineBpmGrid(ctx, {
      masterBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
    });
    const derived = LogicalRhythmEnlinement.deriveRhythmPatternInput({
      bpmTiming: bpm,
      chaosFactor: 0.42,
    });
    expect(derived.timeSignatureNumerator).toBe(4);
    expect(derived.syncopationThreshold).toBe(0.42);
  });

  it("is wired after BPM and before recorded voice in the worker", () => {
    const worker = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const master = readFileSync(
      join(process.cwd(), "src/lib/MasterPipelineRunner.ts"),
      "utf8",
    );
    const bpmIdx = worker.indexOf("BpmEnlinement.enlineBpmGrid");
    const rhythmIdx = worker.indexOf("LogicalRhythmEnlinement.enlineLogicalRhythm");
    const vocalIdx = worker.indexOf("RecordedVoiceStructureEnlinement.enlineRecordedVocal");
    expect(rhythmIdx).toBeGreaterThan(bpmIdx);
    expect(vocalIdx).toBeGreaterThan(rhythmIdx);
    expect(worker).toContain("logicalRhythmEnlinement");
    expect(master).toContain("LogicalRhythmEnlinement");
    expect(master).toContain("rhythmBlueprint");
  });
});
