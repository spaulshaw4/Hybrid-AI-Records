import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ContextFactory } from "@/lib/ExecutionContext";
import { BpmEnlinement } from "@/lib/BpmEnlinement";
import { RecordedVoiceStructureEnlinement } from "@/lib/RecordedVoiceStructureEnlinement";

describe("RecordedVoiceStructureEnlinement", () => {
  it("snaps transients to the master BPM grid and routes by section", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "pro",
      "cortex-worker",
      { sessionNonce: "nonce_vocal", requestId: "req_vocal_1" },
    );

    const aligned = RecordedVoiceStructureEnlinement.enlineRecordedVocal(
      ctx,
      {
        takeId: "take_abc",
        artistName: "Hybrid Artist",
        audioDurationSeconds: 16,
        detectedBpm: 120,
        intendedSection: "CHORUS",
        transientOffsetsMs: [125, 625, 1125],
      },
      120,
    );

    expect(aligned.alignmentBlueprintId).toMatch(/^vocal_struct_enline_nonce_vocal_/);
    expect(aligned.takeId).toBe("take_abc");
    expect(aligned.targetSection).toBe("CHORUS");
    expect(aligned.assignedBusRouting).toBe("chorus_stadium_wide_vocal_bus");
    expect(aligned.structuralFitVerdict).toBe("PERFECT_GRID_FIT");
    expect(aligned.gridSnapOffsetMs).toBe(125);
  });

  it("flags BPM drift as timing compensation or time-stretch", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "free",
      "aligned-runner",
      { sessionNonce: "nonce_drift" },
    );
    const compensated = RecordedVoiceStructureEnlinement.enlineRecordedVocal(
      ctx,
      {
        takeId: "t1",
        artistName: "A",
        audioDurationSeconds: 8,
        detectedBpm: 121,
        intendedSection: "VERSE",
        transientOffsetsMs: [0],
      },
      120,
    );
    expect(compensated.structuralFitVerdict).toBe("TIMING_COMPENSATED");

    const stretch = RecordedVoiceStructureEnlinement.enlineRecordedVocal(
      ctx,
      {
        takeId: "t2",
        artistName: "A",
        audioDurationSeconds: 8,
        detectedBpm: 128,
        intendedSection: "BRIDGE",
        transientOffsetsMs: [0],
      },
      120,
    );
    expect(stretch.structuralFitVerdict).toBe("REQUIRES_TIME_STRETCH");
    expect(stretch.assignedBusRouting).toBe("bridge_filtered_tension_bus");
  });

  it("derives a take from studio vocal artifacts using the BPM grid", () => {
    const ctx = ContextFactory.create(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      "enterprise",
      "cortex-worker",
      { sessionNonce: "nonce_derive_v", requestId: "req_derive_v" },
    );
    const bpmTiming = BpmEnlinement.enlineBpmGrid(ctx, { masterBpm: 100 });
    const take = RecordedVoiceStructureEnlinement.deriveTakeFromStudioPayload({
      ctx,
      bpmTiming,
      lyrics: "hello world",
      durationSeconds: 8,
      hasVocalStem: true,
    });
    expect(take).not.toBeNull();
    expect(take?.transientOffsetsMs.length).toBeGreaterThan(0);
    expect(take?.detectedBpm).toBe(100);
  });

  it("is wired after BPM enlinement in the worker", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/generation-queue-worker.server.ts"),
      "utf8",
    );
    const bpmIdx = source.indexOf("BpmEnlinement.enlineBpmGrid");
    const vocalIdx = source.indexOf("RecordedVoiceStructureEnlinement.enlineRecordedVocal");
    const lyricIdx = source.indexOf("StyleLyricEnlinement.enlineLyricsWithStyle");
    expect(bpmIdx).toBeGreaterThan(-1);
    expect(vocalIdx).toBeGreaterThan(bpmIdx);
    expect(lyricIdx).toBeGreaterThan(vocalIdx);
    expect(source).toContain("recordedVoiceStructureEnlinement");
  });
});
